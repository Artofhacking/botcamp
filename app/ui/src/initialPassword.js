// 正在服务的云函数仍要求开通请求自带至少 8 位密码，而且不会把密码放进响应。
// 新网关忽略这个字段，自己生成，并在响应里返回。页面优先显示响应里的那一个。

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

export function generateInitialPassword(bytes = crypto.getRandomValues(new Uint8Array(20))) {
  let password = ''
  for (const byte of bytes) password += ALPHABET[byte % ALPHABET.length]
  return password
}

export function passwordToShow(created, draft) {
  const issued = created?.password
  if (typeof issued === 'string' && issued.length >= 8 && issued.length <= 200) return issued
  return draft
}

export function issueNote(email, user) {
  const base = `${email} 的初始密码只显示这一次。`
  if (user?.mustChangePassword === true) return `${base}交给用户后，对方第一次登录必须修改。`
  return `${base}请交给用户，对方登录后可以自己修改。`
}
