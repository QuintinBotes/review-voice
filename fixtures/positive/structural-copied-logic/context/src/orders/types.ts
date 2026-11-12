export interface Contact {
  name: string;
  email: string;
}

export interface Participant {
  contact: Contact | null;
}

export interface Order {
  number: string;
  buyer: Participant;
  seller: Participant;
}
