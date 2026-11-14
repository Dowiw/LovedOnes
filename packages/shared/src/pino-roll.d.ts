declare module 'pino-roll' {
  import type { DestinationStream } from 'pino';

  export interface PinoRollOptions {
    file: string | (() => string);
    size?: string | number;
    frequency?: string | number;
    extension?: string;
    symlink?: boolean;
    mkdir?: boolean;
    limit?: {
      count?: number;
      removeOtherLogFiles?: boolean;
    };
    dateFormat?: string;
  }

  export default function buildRoll(options: PinoRollOptions): Promise<DestinationStream>;
}
