export class DuplicateIdentifierError extends Error {
  constructor(identifier: string) {
    super(`Identifier ${identifier} is already registered.`);
  }
}
