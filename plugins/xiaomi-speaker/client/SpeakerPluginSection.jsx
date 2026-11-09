import React from 'react';
import { SpeakerPluginSettings } from "./SpeakerSettings.jsx";
import { SpeakerOutputSection } from "./SpeakerOutputSettings.jsx";

export default function SpeakerPluginSection({ section, host }) {
  if (section === 'playback') return <SpeakerOutputSection key={host.session.get()?.user?.accountId} host={host} />;
  return <SpeakerPluginSettings key={`${host.session.get()?.user?.accountId}:${section}`} host={host} section={section} />;
}
