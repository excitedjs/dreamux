#!/usr/bin/env bash
# Validate the .agents/ knowledge base.
#
# Checks:
#   1. every internal Markdown link inside .agents/ resolves to a file or
#      directory that exists
#   2. every .md file under .agents/ is reachable from .agents/root.md
#      (link graph; flags orphans)
#   3. every decision record is listed in .agents/decisions/README.md
#   4. every /packages/... file path cited by service-topology.md exists
#   5. current reference docs contain no Han text (repo English rule)
#
# Exits 0 on success, non-zero with a noisy list of failures otherwise.
# Run before committing KB changes, and from CI.

set -eu
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
KB_ROOT="$(cd -- "$SCRIPT_DIR/.." &> /dev/null && pwd)"
REPO_ROOT="$(cd -- "$KB_ROOT/.." &> /dev/null && pwd)"

errors=0
kb_file_count=0
link_graph_result_file="$(mktemp "${TMPDIR:-/tmp}/dreamux-kb-check.XXXXXX")"
trap 'rm -f "$link_graph_result_file"' EXIT

# ---------- 1) internal Markdown links resolve ----------
# ---------- 2) orphan detection ----------
# Checks 1 and 2 share Markdown-link parsing and path normalization. Keep the
# portability-sensitive parts here: no GNU realpath flags and no bash 4 hashes.
perl - "$KB_ROOT" "$REPO_ROOT" > "$link_graph_result_file" <<'PERL'
use strict;
use warnings;
use File::Basename qw(dirname);
use File::Find qw(find);

my ($kb_root, $repo_root) = @ARGV;
my $errors = 0;

sub normalize_abs {
  my ($path) = @_;
  my @parts;
  for my $part (split m{/+}, $path) {
    next if $part eq q{} || $part eq q{.};
    if ($part eq q{..}) {
      pop @parts if @parts;
      next;
    }
    push @parts, $part;
  }
  return q{/} . join q{/}, @parts;
}

sub repo_relative {
  my ($path) = @_;
  my $prefix = $repo_root . q{/};
  return substr $path, length $prefix if index($path, $prefix) == 0;
  return $path;
}

sub kb_relative {
  my ($path) = @_;
  my $prefix = $kb_root . q{/};
  return substr $path, length $prefix if index($path, $prefix) == 0;
  return $path;
}

sub strip_fragment {
  my ($target) = @_;
  $target =~ s/#.*\z//;
  return $target;
}

sub read_markdown_links {
  my ($file) = @_;
  open my $fh, q{<}, $file or return;
  my @targets;
  while (my $line = <$fh>) {
    while ($line =~ /\]\(([^)]+)\)/g) {
      push @targets, $1;
    }
  }
  close $fh or return;
  return @targets;
}

my @markdown_files;
find(
  sub {
    return unless -f $_;
    return unless /\.md\z/;
    # `.agents/skills/` holds repo dev skills (symlinked into `.claude/skills/`),
    # not KB prose — they are not part of the root.md link graph.
    return if $File::Find::name =~ m{/skills/};
    push @markdown_files, $File::Find::name;
  },
  $kb_root
);
@markdown_files = sort @markdown_files;

for my $file (@markdown_files) {
  for my $raw_target (read_markdown_links($file)) {
    my $target = strip_fragment($raw_target);
    next if $target eq q{};
    next if $target =~ m{\A(?:http://|https://|mailto:)};

    my $full = $target =~ m{\A/}
      ? normalize_abs($repo_root . $target)
      : normalize_abs(dirname($file) . q{/} . $target);

    next if -e $full;

    print STDERR 'broken markdown link in ', repo_relative($file),
      ' -> ', $target, ' (resolved to ', $full, ")\n";
    ++$errors;
  }
}

my %all = map { $_ => 1 }
  grep { $_ ne 'root.md' }
  map { kb_relative($_) } @markdown_files;

my %seen = ( 'root.md' => 1 );
my @queue = ('root.md');
my $agents_abs = normalize_abs($repo_root . '/.agents');

while (@queue) {
  my $cur = shift @queue;
  my $cur_file = normalize_abs($kb_root . q{/} . $cur);
  next unless -f $cur_file;

  for my $raw_target (read_markdown_links($cur_file)) {
    my $target = strip_fragment($raw_target);
    next if $target eq q{};
    next if $target =~ m{\Ahttp};
    next if $target =~ m{\Amailto:};

    # Resolve BOTH absolute (`/.agents/...`) and relative links to an absolute
    # path, then key by the `.agents`-relative path — exactly like the original
    # `realpath --relative-to=$KB_ROOT`. A relative link that traverses out of
    # `.agents` and back in (`../.agents/reference/x.md`) must therefore key to
    # `reference/x.md`, not stay `../.agents/...`. Links that resolve OUTSIDE
    # `.agents` can never be orphans (not in %all), so skip them.
    my $next_abs = $target =~ m{\A/}
      ? normalize_abs($repo_root . $target)
      : normalize_abs(dirname($cur_file) . q{/} . $target);
    next unless $next_abs eq $agents_abs
      || index($next_abs, $agents_abs . q{/}) == 0;
    my $next = $next_abs eq $agents_abs
      ? q{}
      : substr $next_abs, length($agents_abs) + 1;

    next unless $next =~ /\.md\z/;
    next if exists $seen{$next};

    $seen{$next} = 1;
    push @queue, $next;
  }
}

for my $rel (sort keys %all) {
  next if exists $seen{$rel};
  print STDERR "orphan KB doc: .agents/$rel is not reachable from root.md\n";
  ++$errors;
}

print $errors, q{ }, scalar(keys %all), "\n";
PERL
link_graph_result="$(cat "$link_graph_result_file")"
link_graph_errors="${link_graph_result%% *}"
kb_file_count="${link_graph_result#* }"
errors=$((errors + link_graph_errors))

# ---------- 3) decision index completeness ----------
decision_index="$KB_ROOT/decisions/README.md"
decision_index_entries="$(
  awk '
    /^## Alphabetical Index$/ { in_index = 1; next }
    /^## / && in_index { exit }
    in_index { print }
  ' "$decision_index"
)"
while IFS= read -r f; do
  slug="$(basename "$f" .md)"
  [ "$slug" = "README" ] && continue
  expected="- [$slug]($slug.md)"
  if ! printf '%s\n' "$decision_index_entries" | grep -Fxq -- "$expected"; then
    echo "decision missing from alphabetical index: .agents/decisions/$slug.md" >&2
    errors=$((errors + 1))
  fi
done < <(find "$KB_ROOT/decisions" -maxdepth 1 -type f -name '*.md' | sort)

# ---------- 4) service topology source path liveness ----------
service_topology="$KB_ROOT/reference/service-topology.md"
if [ -f "$service_topology" ]; then
  while IFS= read -r cited; do
    path="${cited%%#*}"
    case "$path" in
      *:[0-9]*) path="${path%:*}" ;;
    esac
    full="$REPO_ROOT$path"
    if [ ! -e "$full" ]; then
      echo "missing service topology source path: reference/service-topology.md -> $path" >&2
      errors=$((errors + 1))
    fi
  done < <(
    perl -ne 'while (m{(/packages/[^`)\s#]+)}g) { print "$1\n" }' "$service_topology" \
      | sort -u
  )
fi

# ---------- 5) current reference docs contain no Han text ----------
while IFS= read -r violation; do
  echo "non-English Han text in current reference: $violation" >&2
  errors=$((errors + 1))
done < <(
  perl -Mutf8 -CS -e '
    for my $file (@ARGV) {
      open my $fh, q{<:encoding(UTF-8)}, $file or die $!;
      my $line = 0;
      while (<$fh>) {
        ++$line;
        print qq{$file:$line\n} if /\p{Han}/;
      }
    }
  ' "$KB_ROOT"/reference/*.md
)

if [ "$errors" -gt 0 ]; then
  echo "" >&2
  echo "$errors KB issue(s) found" >&2
  exit 1
fi
echo "KB OK ($kb_file_count files reachable from root.md)"
