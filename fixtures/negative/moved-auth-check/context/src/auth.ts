export type Request = { role: string; id: string };

export function requireRole(request: Request, role: string) {
  return request.role === role;
}
