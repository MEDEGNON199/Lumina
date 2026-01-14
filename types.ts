
export enum AppMode {
  CHAT = 'CHAT',
  IMAGE = 'IMAGE',
  VOICE = 'VOICE'
}

export interface Message {
  id: string;
  role: 'user' | 'model';
  content: string;
  timestamp: number;
  thinking?: string;
}

export interface GeneratedImage {
  id: string;
  url: string;
  prompt: string;
  timestamp: number;
}
