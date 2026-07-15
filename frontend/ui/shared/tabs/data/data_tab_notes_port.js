let mountNotesHandler = () => null;

export function configureDataTabNotes({ mountNotes } = {}) {
  mountNotesHandler = typeof mountNotes === "function" ? mountNotes : () => null;
}

export function mountDataTabNotes(options = {}) {
  return mountNotesHandler(options);
}
