/**
 * The stable built-in channel provider ref this package ships behind. Dreamux
 * core maps `builtin:feishu` to `@excitedjs/feishu-channel`; the ref string is
 * the package's own public identity, so it is owned here rather than imported
 * from core (which this package must never depend on).
 */
export const BUILTIN_FEISHU_PROVIDER_REF = 'builtin:feishu';
