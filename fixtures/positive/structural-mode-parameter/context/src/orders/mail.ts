export interface Message {
  body: string;
}

export function mail(body: string): Message {
  return { body };
}
