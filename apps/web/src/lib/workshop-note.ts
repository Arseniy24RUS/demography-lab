/** Keep each sticker's paper color stable when the board is filtered or sorted. */
export const noteTone = (id: string) => (id.charCodeAt(id.length - 1) || 0) % 3;
