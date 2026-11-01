/** One explicit click owns saving the original board and preparing one submit. */
export async function prepareStoryboardVideo<T>(input: {
  cardId: string;
  locks: Set<string>;
  identity: () => string | null;
  needsSave: boolean;
  save: () => Promise<boolean>;
  submit: () => Promise<T>;
  onPreparing: (preparing: boolean) => void;
}): Promise<T | null> {
  if (input.locks.has(input.cardId)) return null;
  const identity = input.identity();
  if (!identity) return null;
  input.locks.add(input.cardId);
  input.onPreparing(true);
  try {
    if (input.needsSave && !await input.save()) return null;
    if (input.identity() !== identity) throw new Error("项目、图片、视频参数或账号已改变，本次未提交视频；请重新确认。");
    return await input.submit();
  } finally {
    input.locks.delete(input.cardId);
    input.onPreparing(false);
  }
}
