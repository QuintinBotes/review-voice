export interface Task {
  id: string;
  enabled: boolean;
}

export interface Request {
  loadTasks(): Promise<Task[]>;
  send(tasks: Task[], cancellation: AbortSignal): Promise<{ reason?: string }>;
}
