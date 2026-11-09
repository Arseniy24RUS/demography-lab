export function sha256Hex(input: Uint8Array | ArrayBuffer): Promise<string>;
export function secureBytes(length: number): Uint8Array;
export function randomSecret(): string;
export function randomUuid(): string;
