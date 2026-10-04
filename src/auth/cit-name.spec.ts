import { nameFromCitEmail } from './cit-name';

describe('nameFromCitEmail', () => {
  it.each([
    ['juan.delacruz@cit.edu', { first_name: 'Juan', last_name: 'Delacruz' }],
    ['  MARIA.ANA.SANTOS@CIT.EDU ', { first_name: 'Maria Ana', last_name: 'Santos' }],
    ["ana-marie.o'neil@cit.edu", { first_name: 'Ana-Marie', last_name: "O'Neil" }],
    ['student@cit.edu', null],
    ['juan..santos@cit.edu', null],
    ['juan.santos@example.com', null],
    ['juan.santos@fakecit.edu', null],
  ])('derives a name only from a supported CIT address: %s', (email, expected) => {
    expect(nameFromCitEmail(email)).toEqual(expected);
  });
});
