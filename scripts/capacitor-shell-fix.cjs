// Work around a Windows environment issue where os.userInfo() fails even though
// Android tooling does not need the current user's shell information.
const os = require("node:os");
const originalUserInfo = os.userInfo;
os.userInfo = (...args) => {
  try {
    return originalUserInfo(...args);
  } catch {
    return { username: "sajilo", uid: -1, gid: -1, shell: process.env.COMSPEC || "cmd.exe", homedir: process.cwd() };
  }
};
