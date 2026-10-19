import { fileURLToPath } from 'node:url';

export default {
  test: {
    globalSetup: fileURLToPath(
      new URL('../../../common/testing/isolated-home.mjs', import.meta.url),
    ),
    setupFiles: fileURLToPath(
      new URL(
        '../../../common/testing/apply-isolated-home.mjs',
        import.meta.url,
      ),
    ),
  },
};
