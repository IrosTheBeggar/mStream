const fs = require("fs").promises;
const path = require("path");
const dbApi = require('../api/db');

exports.getFileType = (pathString) => {
  return path.extname(pathString).substr(1);
}

exports.getDirectoryContents = async (directory, fileTypeFilter, sort, pm, metaDir, user) => {
  const rt = { directories: [], files: [] };
  for (const file of await fs.readdir(directory)) {
    try {
      var stat = await fs.stat(path.join(directory, file));
    } catch (e) { continue; } /* Bad file or permission error, ignore and continue */

    // Handle Directory
    if (stat.isDirectory()) {
      rt.directories.push({ name: file });
      continue;
    }

    // Handle Files
    const extension = this.getFileType(file).toLowerCase();
    if (fileTypeFilter && extension in fileTypeFilter) {
      const fileInfo = {
        type: extension,
        name: file
      };
      
      if (pm) {
        fileInfo.metadata = dbApi.pullMetaData(path.join(metaDir, file).replace(/\\/g, '/'), user);
      }

      rt.files.push(fileInfo);
    }
  }

  if (sort && sort === true) {
    // Sort it because we can't rely on the OS returning it pre-sorted
    rt.directories.sort((a, b) => { return a.name.localeCompare(b.name); });
    rt.files.sort((a, b) => { return a.name.localeCompare(b.name); });
  }

  return rt;
}
