module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // WatermelonDB model decorators (the standalone WM babel plugin
    // no longer ships with @nozbe/watermelondb 0.28).
    ['@babel/plugin-proposal-decorators', {version: 'legacy'}],
    ['@babel/plugin-transform-class-properties', {loose: true}],
  ],
};
