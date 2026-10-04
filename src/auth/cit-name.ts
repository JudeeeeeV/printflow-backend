/** CIT addresses use first.last; extra given-name segments become spaces. */
export function nameFromCitEmail(email?: string) {
  const match = email?.trim().toLowerCase().match(/^([^@\s]+)@cit\.edu$/);
  const parts = match?.[1].split('.') ?? [];
  if (parts.length < 2 || parts.some((part) => !part)) return null;
  const titleCase = (value: string) =>
    value.replace(/(^|[\s'-])\p{L}/gu, (letter) => letter.toUpperCase());
  return {
    first_name: titleCase(parts.slice(0, -1).join(' ')),
    last_name: titleCase(parts[parts.length - 1]),
  };
}
