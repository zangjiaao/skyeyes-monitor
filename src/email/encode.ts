export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function chunkRecipients(recipients: readonly string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < recipients.length; index += size) {
    chunks.push(recipients.slice(index, index + size));
  }
  return chunks;
}
