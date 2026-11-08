export function deleteWidget(widgets: Map<string, string>, id: string) {
  return widgets.delete(id);
}
