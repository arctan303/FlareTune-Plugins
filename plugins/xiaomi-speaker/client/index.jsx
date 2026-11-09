export { default } from './SpeakerPluginSection.jsx';
export { startXiaomiRuntime as start } from './runtime.js';
export const loadAction = () => import('./SpeakerOutputSettings.jsx');
export const actions = Object.freeze(['output']);
