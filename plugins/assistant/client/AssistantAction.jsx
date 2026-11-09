import React from 'react';
import { t } from "@flaretune/plugin-sdk/pure";
import { clearConversation } from "./client.js";

export default function AssistantAction({ host, onClose }) {
  const started = React.useRef(false);
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    void clearConversation(host).catch(error => {
      if (host.isCurrent() && error?.name !== 'AbortError') host.notify(t(error?.message || '清空失败，请重试。'));
    }).finally(() => onClose?.());
  }, [host, onClose]);
  return null;
}
