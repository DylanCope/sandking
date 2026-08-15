/**
 * Arm forced cancellation against the absolute deadline retained in canonical
 * state. The escalation callback is invoked when the deadline becomes due even
 * if platform-specific process-tree preparation is still pending inside it.
 *
 * @param {string} cooperativeDeadlineAt
 * @param {() => Promise<void>} escalate
 * @param {{now?: () => number, setTimer?: typeof setTimeout}} [timing]
 */
export const scheduleCancellationEscalation = (
  cooperativeDeadlineAt,
  escalate,
  timing = {},
) => {
  const currentTime = timing.now ?? Date.now;
  const setTimer = timing.setTimer ?? setTimeout;
  let reportDeadlineReached = () => {};
  const deadlineReached = new Promise((resolve) => {
    reportDeadlineReached = () => resolve(undefined);
  });
  /** @type {(value: void | PromiseLike<void>) => void} */
  let finishOperation = () => {};
  /** @type {(reason?: unknown) => void} */
  let failOperation = () => {};
  let operationSettled = false;
  let escalationStarted = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let activeTimer;
  const operation = new Promise((resolve, reject) => {
    finishOperation = (value) => {
      if (operationSettled) return;
      operationSettled = true;
      resolve(value);
    };
    failOperation = (reason) => {
      if (operationSettled) return;
      operationSettled = true;
      reject(reason);
    };
  });
  const deadline = Date.parse(cooperativeDeadlineAt);
  const escalateWhenDue = () => {
    if (operationSettled) return;
    const remaining = deadline - currentTime();
    if (remaining > 0) {
      activeTimer = setTimer(escalateWhenDue, remaining);
      return;
    }
    escalationStarted = true;
    let escalation;
    try {
      escalation = escalate();
    } catch (error) {
      reportDeadlineReached();
      failOperation(error);
      return;
    }
    reportDeadlineReached();
    escalation.then(finishOperation, failOperation);
  };
  activeTimer = setTimer(escalateWhenDue, Math.max(0, deadline - currentTime()));
  const timer = activeTimer;
  const cancel = () => {
    if (escalationStarted || operationSettled) return false;
    clearTimeout(activeTimer);
    finishOperation();
    return true;
  };
  return { timer, deadlineReached, operation, cancel };
};
