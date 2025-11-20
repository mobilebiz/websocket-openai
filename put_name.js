/**
 * ユーザー名を記録します。
 * 
 * @param {string} name - 記録するユーザー名
 * @returns {Promise<void>}
 */
export async function putName(name) {
  if (!name || typeof name !== 'string') {
    console.warn('put_name: 名前が正しく受け取れませんでした', name);
    return;
  }

  console.log(`🧑 ユーザー名を記録: ${name}`);
}

