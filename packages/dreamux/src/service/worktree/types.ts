export interface TeamMateWorktreeRequest {
  mode: 'reuse-cwd' | 'managed';
  slug?: string | undefined;
  base_ref?: string | undefined;
  branch?: string | undefined;
  cleanup?: 'keep' | 'delete-on-close' | undefined;
}
