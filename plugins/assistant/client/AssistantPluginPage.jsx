import React from 'react';
import AssistantView from "./AssistantView.jsx";
import AssistantSettings from "./AssistantSettings.jsx";

export default function AssistantPluginPage({ host, pageId = 'conversation', context = {} }) {
  if (pageId === 'configuration') return <AssistantSettings host={host} />;
  return <AssistantView host={host} context={context} section={pageId === 'memory' ? 'memory' : 'conversation'} />;
}
