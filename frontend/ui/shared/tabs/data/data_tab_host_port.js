let publishHostInputsHandler = () => {};

export function configureDataTabHostPublisher(publishHostInputs) {
  publishHostInputsHandler = typeof publishHostInputs === "function"
    ? publishHostInputs
    : () => {};
}

export function publishDataTabHostInputs(dependencies) {
  return publishHostInputsHandler(dependencies);
}
