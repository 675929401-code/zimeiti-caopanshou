/** Classify current workspace and administrator validation receipts; callers still enforce ownership. */
export function isCurrentDigitalHumanTask(row: Record<string, unknown>) {
  return ['digital-human:photo', 'digital-human:video'].includes(String(row.task_label || ''))
    && (String(row.client_request_id || '').startsWith('digital-')
      || /^vav_[a-f0-9]{64}$/u.test(String(row.client_request_id || '')));
}
export const DIGITAL_HUMAN_TASK_FILTER = 'and(task_label.in.(digital-human:photo,digital-human:video),or(client_request_id.like.digital-%,client_request_id.like.vav_%))';
