export const isAssistantCompositionEvent = (event, composing = false) => composing
  || event?.isComposing === true || event?.nativeEvent?.isComposing === true
  || event?.keyCode === 229 || event?.nativeEvent?.keyCode === 229;
