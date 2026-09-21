export {};

declare global {
  interface NumberConstructor {
    isInteger(number: unknown): number is number;
  }
}
