/** 正文保存不携带旧表单中的外观默认值，也不借 emphasis:null 改变全片样式。 */
export function captionCardUpdate(unified: boolean, values: Record<string, unknown>): Record<string, unknown> {
  if (!unified) return values;
  return { action: "update", text: values.text, display: values.display };
}
