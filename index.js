/**
 * @format
 */

import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

// Push notifications (Firebase) are TEMPORARILY REMOVED in v1.0.11 as a
// diagnostic — the placeholder google-services.json was the prime suspect
// for the immediate-crash-on-open. Push will be re-added once Hamza provides
// the real google-services.json from his Firebase project.

AppRegistry.registerComponent(appName, () => App);
