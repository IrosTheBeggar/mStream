const killThese = [];

process.on('exit', code => {
  // Kill them all
  killThese.forEach(func => {
    if (typeof func === 'function') {
      try {
        func();
      }catch (err) {
        console.log('Error: Failed to run kill function');
      }
    }
  });
});

exports.addToKillQueue = (func) => {
  killThese.push(func);
}
