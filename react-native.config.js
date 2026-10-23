module.exports = {
  assets: ['./assets/fonts/'],
  dependencies: {
    // WatermelonDB 0.28.0 keeps its Android native module under
    // native/android/ (not android/), so autolinking cannot find it.
    // Without this, NativeModules.WMDatabaseBridge is undefined and
    // `new SQLiteAdapter()` throws at import time -> instant crash
    // on launch with no UI (v1.0.9-v1.0.13 root cause).
    '@nozbe/watermelondb': {
      platforms: {
        android: {
          // Relative to the package root (node_modules/@nozbe/watermelondb/)
          sourceDir: './native/android',
        },
      },
    },
  },
};
