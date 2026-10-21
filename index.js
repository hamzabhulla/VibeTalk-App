/**
 * @format
 */

import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
import {AppRegistry} from 'react-native';
import messaging from '@react-native-firebase/messaging';
import App from './App';
import {name as appName} from './app.json';

// Background/quit-state push handler. Notification messages are
// displayed by the system; data messages land here (no-op for now —
// opening the app syncs everything). Guarded: with the placeholder
// google-services.json this quietly fails instead of crashing.
try {
  messaging().setBackgroundMessageHandler(async () => {});
} catch (e) {
  // Firebase not configured yet — push stays off, app unaffected.
}

AppRegistry.registerComponent(appName, () => App);
