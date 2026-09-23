// Acknowledging a message is not ending the conversation or asking for a new
// topic. Keep this shared across routing, tone and material selection.
export function isAcknowledgement(text) {
  return /^(?:嗯+|好(?:的|吧|呢|呀|啊)?|知道了|收到)(?:[，,\s]*(?:嗯+|好(?:的|吧|呢|呀|啊)?|知道了|收到))*[。！!～~\s]*$/u.test(String(text ?? '').trim());
}
export function isRecallRequest(text) {
  return /记得|我(?:之前|以前|上次).{0,6}(?:说|提)|我在哪|我喜欢怎么|(?:什么|哪里|哪儿|哪个|哪趟|哪班|几点|多少|什么时候).{0,12}来着/u.test(String(text ?? ''));
}
