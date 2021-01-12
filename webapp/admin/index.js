const ADMINDATA = (() => {
  const module = {};

  // Used for handling the file explorer selection
  module.sharedSelect = { value: '' };

  // Used for modifying a user
  module.selectedUser = { value: '' };

  module.folders = {};
  module.foldersUpdated = { ts: 0 };
  module.users = {};
  module.usersUpdated = { ts: 0 };
  module.dbParams = {};
  module.dbParamsUpdated = { ts: 0 };
  module.serverParams = {};
  module.serverParamsUpdated = { ts: 0 };

  module.getFolders = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/directories`
    });

    Object.keys(res.data).forEach(key=>{
      module.folders[key] = res.data[key];
    });

    module.foldersUpdated.ts = Date.now();
  };

  module.getUsers = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/users`
    });

    Object.keys(res.data).forEach(key=>{
      module.users[key] = res.data[key];
    });

    module.usersUpdated.ts = Date.now();
  };

  module.getDbParams = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/db/params`
    });

    Object.keys(res.data).forEach(key=>{
      module.dbParams[key] = res.data[key];
    });

    module.dbParamsUpdated.ts = Date.now();
  }

  module.getServerParams = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/config`
    });

    Object.keys(res.data).forEach(key=>{
      module.serverParams[key] = res.data[key];
    });

    module.serverParamsUpdated.ts = Date.now();
  }

  return module;
})();

// Load in data
ADMINDATA.getFolders();
ADMINDATA.getUsers();
ADMINDATA.getDbParams();
ADMINDATA.getServerParams();

// initialize modal
M.Modal.init(document.querySelectorAll('.modal'), {
  onCloseEnd: () => {
    // reset modal on every close
    modVM.currentViewModal = 'null-modal';
  }
});

const foldersView = Vue.component('folders-view', {
  data() {
    return {
      componentKey: false, // Flip this value to force re-render
      dirName: '',
      folder: ADMINDATA.sharedSelect,
      foldersTS: ADMINDATA.foldersUpdated,
      folders: ADMINDATA.folders,
      submitPending: false
    };
  },
  template: `
    <div>
      <div class="container">
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">Add Folder</span>
                <form id="choose-directory-form" @submit.prevent="submitForm">
                  <div class="row">
                    <div class="input-field col s12">
                      <input v-on:click="addFolderDialog()" @blur="maybeResetForm()" v-model="folder.value" id="folder-name" required type="text" class="validate">
                      <label for="folder-name">Select Directory</label>
                      <span class="helper-text">Click to choose directory</span>
                    </div>
                  </div>
                  <div class="row">
                    <div class="input-field col s12">
                      <input @blur="maybeResetForm()" pattern="[a-zA-Z0-9-]+" v-model="dirName" id="add-directory-name" required type="text" class="validate">
                      <label for="add-directory-name">Server Path Alias (vPath)</label>
                      <span class="helper-text">No special characters or spaces</span>
                    </div>
                  </div>
                  <div class="row">
                    <div class="col m6 s12">
                      <div class="pad-checkbox"><label>
                        <input id="folder-autoaccess" type="checkbox" checked/>
                        <span>Give Access To All Users</span>
                      </label></div>
                    </div>
                    <button class="btn green waves-effect waves-light col m6 s12" type="submit" :disabled="submitPending === true">
                      {{submitPending === false ? 'Add Folder' : 'Adding...'}}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div v-show="foldersTS.ts === 0" class="row">
        <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
      </div>
      <div v-show="foldersTS.ts > 0" class="row">
        <div class="col s12">
          <h5>Directories</h5>
          <table>
            <thead>
              <tr>
                <th>Server Path Alias (vPath)</th>
                <th>Directory</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(v, k) in folders">
                <td>{{k}}</td>
                <td>{{v.root}}</td>
                <td>[<a v-on:click="removeFolder(k, v.root)">remove</a>]</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>`,
    created: function() {
      ADMINDATA.sharedSelect.value = '';
    },
    watch: {
      'folder.value': function (newVal, oldVal) {
        this.makeVPath(newVal);
      }
    },
    methods: {
      makeVPath(dir) {
        const newName = dir.split(/[\\\/]/).pop().toLowerCase().replace(' ', '-').replace(/[^a-zA-Z0-9-]/g, "");
        
        // TODO: Check that vpath doesn't already exist

        this.dirName = newName;
        this.$nextTick(() => {
          M.updateTextFields();
        });
      },
      maybeResetForm: function() {
        if (this.dirName === '' && this.folder.value === '') {
          document.getElementById("choose-directory-form").reset();
        }
      },
      addFolderDialog: function (event) {
        modVM.currentViewModal = 'file-explorer-modal';
        M.Modal.getInstance(document.getElementById('admin-modal')).open();
      },
      submitForm: async function () {
        if (ADMINDATA.folders[this.dirName]) {
          iziToast.warn({
            title: 'Server Path already in use',
            position: 'topCenter',
            timeout: 3500
          });
          return;
        }

        try {
          this.submitPending = true;

          await API.axios({
            method: 'PUT',
            url: `${API.url()}/api/v1/admin/directory`,
            data: {
              directory: this.folder.value,
              vpath: this.dirName,
              autoAccess: document.getElementById('folder-autoaccess').checked
            }
          });

          if (document.getElementById('folder-autoaccess').checked) {
            Object.values(ADMINDATA.users).forEach(user => {
              user.vpaths.push(this.dirName);
            });
          }

          Vue.set(ADMINDATA.folders, this.dirName, { root: this.folder.value });
          this.dirName = '';
          this.folder.value = '';
          this.$nextTick(() => {
            M.updateTextFields();
          });
        }catch(err) {
          iziToast.error({
            title: 'Failed to add directory',
            position: 'topCenter',
            timeout: 3500
          });
        } finally {
          this.submitPending = false;
        }
      },
      removeFolder: async function(vpath, folder) {
        iziToast.question({
          timeout: 20000,
          close: false,
          overlayClose: true,
          overlay: true,
          displayMode: 'once',
          id: 'question',
          zindex: 99999,
          layout: 2,
          maxWidth: 600,
          title: `Remove access to <b>${folder}</b>?`,
          message: `No files will be deleted. Your server will need to reboot.`,
          position: 'center',
          buttons: [
            ['<button><b>Remove</b></button>', (instance, toast) => {
              instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
              API.axios({
                method: 'DELETE',
                url: `${API.url()}/api/v1/admin/directory`,
                data: { vpath: vpath }
              }).then(() => {
                iziToast.warning({
                  title: 'Server Rebooting. Please wait 30s for the server to come back online',
                  position: 'topCenter',
                  timeout: 3500
                });
                Vue.delete(ADMINDATA.folders, vpath);
                Object.values(ADMINDATA.users).forEach(user => {
                  if (user.vpaths.includes(vpath)) {
                    user.vpaths.splice(user.vpaths.indexOf(vpath), 1);
                  }
                });
              }).catch(() => {
                iziToast.error({
                  title: 'Failed to remove folder',
                  position: 'topCenter',
                  timeout: 3500
                });
              });
            }, true],
            ['<button>Go Back</button>', (instance, toast) => {
              instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            }],
          ]
        });
      }
    }
});

const usersView = Vue.component('users-view', {
  data() {
    return {
      directories: ADMINDATA.folders,
      users: ADMINDATA.users,
      usersTS: ADMINDATA.usersUpdated,
      selectInstance: null,
      newUsername: '',
      newPassword: '',
      userClass: Object.keys(ADMINDATA.users).length === 0 ? 'admin' : 'user',
      submitPending: false
    };
  },
  template: `
    <div>
      <div class="container">
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
              <span class="card-title">Add User</span>
                <form id="add-user-form" @submit.prevent="addUser">
                  <div class="row">
                    <div class="input-field directory-name-field col s12 m6">
                      <input @blur="maybeResetForm()" pattern="[a-zA-Z0-9-]+" v-model="newUsername" id="new-username" required type="text" class="validate">
                      <label for="new-username">Username</label>
                    </div>
                    <div class="input-field directory-name-field col s12 m6">
                      <input @blur="maybeResetForm()" v-model="newPassword" id="new-password" required type="password" class="validate">
                      <label for="new-password">Password</label>
                    </div>
                  </div>
                  <div class="row">
                    <div class="input-field col s12">
                      <select class="material-select" :disabled="Object.keys(directories).length === 0" id="new-user-dirs" multiple>
                        <option disabled selected value="" v-if="Object.keys(directories).length === 0">You must add a directory before adding a user</option>
                        <option selected v-for="(key, value) in directories" :value="value">{{ value }}</option>
                      </select>
                      <label for="new-user-dirs">Select User's Directories</label>
                    </div>
                  </div>
                  <div class="row">
                    <div class="input-field col s12 m6">
                      <select class="material-select" v-model="userClass">
                        <option value="admin">Admin</option>
                        <option value="user">User</option>
                        <option value="guest">Guest</option>
                      </select>
                      <label>Access Level</label>
                    </div>
                    <div class="col s12 m6">
                      <!-- <a v-on:click="openLastFmModal()" href="#!">Add last.fm account</a> -->
                    </div>
                  </div>
                  <div class="row">
                    <button id="submit-add-user-form" class="btn green waves-effect waves-light col m6 s12" type="submit" :disabled="submitPending === true">
                      {{submitPending === false ? 'Add User' : 'Adding...'}}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div v-show="usersTS.ts === 0" class="row">
        <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
      </div>
      <div v-show="usersTS.ts > 0" class="row">
        <div class="col s12">
          <h5>Users</h5>
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Directories</th>
                <th>Access</th>
                <th>Modify</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(v, k) in users">
                <td>{{k}}</td>
                <td>{{v.vpaths.join(', ')}}</td>
                <td>{{v.admin === true ? 'admin' : (v.guest === true ? 'guest' : 'user')}}</td>
                <td>
                  [<a v-on:click="changePassword(k)">change pass</a>]
                  [<a v-on:click="changeVPaths(k)">change folders</a>]
                  [<a v-on:click="changeAccess(k)">access</a>]
                  [<a v-on:click="deleteUser(k)">del</a>]
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>`,
    mounted: function () {
      this.selectInstance = M.FormSelect.init(document.querySelectorAll(".material-select"));
    },
    beforeDestroy: function() {
      this.selectInstance[0].destroy();
      this.selectInstance[1].destroy();
    },
    methods: {
      openLastFmModal: function() {

      },
      maybeResetForm: function() {

      },
      changeVPaths: function(username) {
        ADMINDATA.selectedUser.value = username;
        modVM.currentViewModal = 'user-vpaths-modal';
        M.Modal.getInstance(document.getElementById('admin-modal')).open();
      },
      changeAccess: function(username) {
        ADMINDATA.selectedUser.value = username;
        modVM.currentViewModal = 'user-access-modal';
        M.Modal.getInstance(document.getElementById('admin-modal')).open();
      },
      changePassword: function(username) {
        ADMINDATA.selectedUser.value = username;
        modVM.currentViewModal = 'user-password-modal';
        M.Modal.getInstance(document.getElementById('admin-modal')).open();
      },
      deleteUser: function (username) {
        iziToast.question({
          timeout: 20000,
          close: false,
          overlayClose: true,
          overlay: true,
          displayMode: 'once',
          id: 'question',
          zindex: 99999,
          title: `Delete <b>${username}</b>?`,
          position: 'center',
          buttons: [
            ['<button><b>Delete</b></button>', (instance, toast) => {
              instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
              API.axios({
                method: 'DELETE',
                url: `${API.url()}/api/v1/admin/users`,
                data: { username: username }
              }).then(() => {
                Vue.delete(ADMINDATA.users, username);
              }).catch(() => {
                iziToast.error({
                  title: 'Failed to delete user',
                  position: 'topCenter',
                  timeout: 3500
                });
              });
            }, true],
            ['<button>Go Back</button>', (instance, toast) => {
              instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            }],
          ]
        });
      },
      addUser: async function (event) {
        try {
          this.submitPending = true;

          const selected = document.querySelectorAll('#new-user-dirs option:checked');

          const data = {
            username: this.newUsername,
            password: this.newPassword,
            vpaths: Array.from(selected).map(el => el.value),
            admin: this.userClass === 'admin' ? true : false,
            guest: this.userClass === 'guest' ? true : false
          };

          await API.axios({
            method: 'PUT',
            url: `${API.url()}/api/v1/admin/users`,
            data: data
          });

          Vue.set(ADMINDATA.users, this.newUsername, { vpaths: data.vpaths, admin: data.admin, guest: data.guest });
          this.newUsername = '';
          this.newPassword = '';

          // if this is the first user, prompt user and take them to login page
          if (Object.keys(ADMINDATA.users).length === 1) {
            iziToast.question({
              timeout: false,
              close: false,
              overlay: true,
              displayMode: 'once',
              id: 'question',
              zindex: 99999,
              title: 'You will be taken the login page',
              position: 'center',
              buttons: [['<button>Go!</button>', (instance, toast) => {
                API.checkAuthAndKickToLogin();
                instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
              }, true]],
            });
          }

          this.$nextTick(() => {
            M.updateTextFields();
          });
        }catch(err) {
          iziToast.error({
            title: 'Failed to add user',
            position: 'topCenter',
            timeout: 3500
          });
        }finally {
          this.submitPending = false;
        }
      }
    }
});

const advancedView = Vue.component('advanced-view', {
  data() {
    return {
      params: ADMINDATA.serverParams,
      paramsTS: ADMINDATA.serverParamsUpdated
    };
  },
  template: `
    <div v-if="paramsTS.ts === 0" class="row">
      <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
    </div>
    <div v-else>
      <div class="container">
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">Security</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>File Uploading:</b> {{params.noUpload === false ? 'Enabled' : 'Disabled'}}</td>
                      <td>
                        [<a v-on:click="toggleFileUpload()">edit</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>Auth Key:</b> ****************{{params.secret}}</td>
                      <td>
                        [<a v-on:click="generateNewKey()">edit</a>]
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">Network Settings</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>Port:</b> {{params.port}}</td>
                      <td>
                        [<a v-on:click="openModal('edit-port-modal')">edit</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>Address:</b> {{params.address}}</td>
                      <td>
                        [<a v-on:click="openModal('edit-address-modal')">edit</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>SSL:</b></td>
                      <td>
                        [<a>edit</a>]
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">Storage Settings</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>Write Logs:</b></td>
                      <td>
                        [<a>edit</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>Album Art:</b></td>
                      <td>
                        [<a>edit</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>DB Directory:</b></td>
                      <td>
                        [<a>edit</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>Logs Directory:</b></td>
                      <td>
                        [<a>edit</a>]
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  methods: {
    openModal: function(modalView) {
      modVM.currentViewModal = modalView;
      M.Modal.getInstance(document.getElementById('admin-modal')).open();
    },
    generateNewKey: function() {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: 'Generate a New Auth Key?',
        message: 'All active login sessions will be invalidated.  You will need to login after',
        position: 'center',
        buttons: [
          [`<button><b>Generate Key</b></button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/config/secret`,
              data: { strength: 128 }
            }).then(() => {
              instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
              API.checkAuthAndKickToLogin();
            }).catch(() => {
              instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
              iziToast.error({
                title: 'Failed',
                position: 'topCenter',
                timeout: 3500
              });
            });
          }, true],
          ['<button>Go Back</button>', (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    toggleFileUpload: function() {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `${this.params.noUpload === false ? 'Disable' : 'Enable'} File Uploading?`,
        position: 'center',
        buttons: [
          [`<button><b>${this.params.noUpload === false ? 'Disable' : 'Enable'}</b></button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/config/noupload`,
              data: { noUpload: !this.params.noUpload }
            }).then(() => {
              // update fronted data
              Vue.set(ADMINDATA.serverParams, 'noUpload', !this.params.noUpload);

              iziToast.success({
                title: 'Updated Successfully',
                position: 'topCenter',
                timeout: 3500
              });
            }).catch(() => {
              instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
              iziToast.error({
                title: 'Failed',
                position: 'topCenter',
                timeout: 3500
              });
            });
          }, true],
          ['<button>Go Back</button>', (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
  }
});


const dbView = Vue.component('db-view', {
  data() {
    return {
      dbParams: ADMINDATA.dbParams
    };
  },
  template: `
    <div>
      <div class="container">
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">DB Scan Settings</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>Scan Interval:</b> {{dbParams.scanInterval}} hours</td>
                      <td>
                        [<a v-on:click="openModal('edit-scan-interval-modal')">edit</a>]
                      </td>
                    </tr>
                    <tr>
                    <td><b>Save Interval:</b> {{dbParams.saveInterval}} files</td>
                      <td>
                        [<a v-on:click="openModal('edit-save-interval-modal')">edit</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>Boot Scan Delay:</b> {{dbParams.bootScanDelay}} seconds</td>
                      <td>
                        [<a v-on:click="openModal('edit-boot-scan-delay-modal')">edit</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>Pause Between Files:</b> {{dbParams.pause}} milliseconds</td>
                      <td>
                        [<a v-on:click="openModal('edit-pause-modal')">edit</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>Skip Image Metadata:</b> {{dbParams.skipImg}}</td>
                      <td>
                        [<a v-on:click="toggleSkipImg()">edit</a>]
                      </td>
                    </tr>
                    <tr>
                      <td><b>Max Concurrent Scans:</b> {{dbParams.maxConcurrentTasks}}</td>
                      <td>
                        [<a v-on:click="openModal('edit-max-scan-modal')">edit</a>]
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">Scan Queue & Stats</span>
                <a v-on:click="scanDB" class="waves-effect waves-light btn">Start A Scan</a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    scanDB: async function() {
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/scan/all`
        });

        iziToast.success({
          title: 'Scan Started',
          position: 'topCenter',
          timeout: 3500
        });
      } catch (err) {
        iziToast.error({
          title: 'Failed to Start Scan',
          position: 'topCenter',
          timeout: 3500
        });
      }
    },
    toggleSkipImg: function() {
      iziToast.question({
        timeout: 20000,
        close: false,
        overlayClose: true,
        overlay: true,
        displayMode: 'once',
        id: 'question',
        zindex: 99999,
        layout: 2,
        maxWidth: 600,
        title: `${this.dbParams.skipImg === true ? 'Disable' : 'Enable'} Image Skip?`,
        position: 'center',
        buttons: [
          [`<button><b>${this.dbParams.skipImg === true ? 'Disable' : 'Enable'}</b></button>`, (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
            API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/db/params/skip-img`,
              data: { skipImg: !this.dbParams.skipImg }
            }).then(() => {
              // update fronted data
              Vue.set(ADMINDATA.dbParams, 'skipImg', !this.dbParams.skipImg);

              iziToast.success({
                title: 'Updated Successfully',
                position: 'topCenter',
                timeout: 3500
              });
            }).catch(() => {
              iziToast.error({
                title: 'Failed',
                position: 'topCenter',
                timeout: 3500
              });
            });
          }, true],
          ['<button>Go Back</button>', (instance, toast) => {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
        ]
      });
    },
    openModal: function(modalView) {
      modVM.currentViewModal = modalView;
      M.Modal.getInstance(document.getElementById('admin-modal')).open();
    }
  }
});

const rpnView = Vue.component('rpn-view', {
  data() {
    return {

    };
  },
  template: `
    <div>
      RPN View
    </div>`
});

const infoView = Vue.component('info-view', {
  data() {
    return {

    };
  },
  template: `
    <div class="container">
      <div class="row">
        <svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" x="0" y="0" viewBox="0 0 612 153" xml:space="preserve"><style>.st0,.st1{fill-rule:evenodd;clip-rule:evenodd;fill:#264679}.st1{fill:#6684b2}</style><path class="st0" d="M179.9 45.5c-6.2 0-11.5 1.7-15.9 5s-6.5 8.1-6.5 14.4c0 4.9 1.3 9.1 3.8 12.4 2.5 3.4 5.7 5.8 9.3 7.3 3.7 1.5 7.3 2.8 11 3.8s6.8 2.3 9.3 3.9c2.5 1.5 3.8 3.5 3.8 5.8 0 4.8-4.4 7.2-13.1 7.2h-24.1V118h24.1c17.1 0 25.6-6.7 25.6-20.2 0-1.9-.2-3.8-.6-5.8-.4-2-1.2-4-2.6-6-1.3-2.1-3.3-3.7-5.8-4.9-2.5-1.2-6.4-2.7-11.5-4.5l-8.8-3.1c-.7-.2-1.7-.7-2.9-1.3-1.3-.7-2.2-1.3-2.8-1.9-.6-.6-1.1-1.4-1.6-2.3-.5-.9-.7-2-.7-3.2 0-2 1-3.5 2.9-4.6 1.9-1.1 4.3-1.6 7-1.6h24.6V45.5h-24.5zM226.4 58.3v31c0 10.2 2.5 17.6 7.6 22 5.1 4.4 13 6.6 23.7 6.6v-12.8c-2.7 0-4.9-.2-6.8-.4-1.8-.3-3.7-.9-5.8-1.9-2-.9-3.6-2.6-4.7-4.9-1.1-2.3-1.6-5.2-1.6-8.7V58.3h18.8V45.5h-18.8V31.6L214 58.3h12.4zM281.1 118V76.8c0-7.2.9-12 2.6-14.5 1-1.3 2.2-2.2 3.6-2.8 1.4-.6 2.6-1 3.6-1.1 1-.1 2.5-.1 4.3-.1H310V45.5h-12.2c-3.6 0-6.5.1-8.6.3-2.1.2-4.5.9-7.3 2s-5.1 2.8-7.1 5c-4 4.4-6 12.4-6 24V118h12.3zM326.2 53.8c-6.2 7.4-9.3 17-9.3 28.9 0 10.7 3.2 19.4 9.5 26.2s14.7 10.1 25.3 10.1c8.7 0 16.3-2.7 22.7-8.1L366 102c-3.7 2.1-8.5 3.2-14.3 3.2-6.5 0-11.8-2.3-15.8-6.9-4-4.6-6-10.5-6-17.9 0-7 1.9-12.9 5.6-17.9 3.8-5 8.9-7.5 15.5-7.5 3.3 0 6.1.8 8.2 2.4 2.1 1.6 3.2 4 3.2 7.2 0 5-1.2 8.5-3.6 10.6-2.4 2.1-6.7 3.2-12.9 3.2h-6.7v11.7h5.7c20.3 0 30.5-8.5 30.5-25.4 0-13.6-7.9-20.7-23.7-21.5-10.8-.2-19.3 3.3-25.5 10.6zM412.3 73.2c-7.4 0-13.6 1.9-18.5 5.7-4.9 3.8-7.4 9.4-7.4 16.7 0 7.3 2.3 12.9 7 16.7 4.6 3.8 10.9 5.7 18.8 5.7h31V73.6c0-9.1-2.4-16-7.2-20.8-4.8-4.8-11.7-7.2-20.7-7.2h-22.9v12.8h22.3c10.9 0 16.4 6.1 16.4 18.2v28.7h-18.4c-9.1 0-13.6-3.2-13.6-9.8 0-3.3 1.2-5.9 3.6-7.8 2.4-1.8 5.8-2.7 10.2-2.7 5.1 0 9.4 1.4 12.9 4.3v-14c-4.9-1.4-9.3-2.1-13.5-2.1zM458.8 118H471V58.3h24.4V118h12.2V58.3h5.7c6.8 0 11.3.7 13.5 2 4.3 2.5 6.5 7.7 6.5 15.5V118h12.2V75.7c0-6-.6-11.2-1.9-15.5-1.2-4.3-3.9-7.8-7.9-10.6-3.9-2.7-9.1-4.1-15.7-4.1h-61.4V118z"/><path class="st1" d="M75 118.5v-83l21 13v70z"/><path fill-rule="evenodd" clip-rule="evenodd" fill="#26477b" d="M99 118.5v-69l11.5 7 10.5-7v69z"/><path class="st1" d="M124 118.5v-70l21-13v83z"/></svg>
      </div>
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Developed & Designed By</span>
              <h3>Paul Sori</h3>
              <h4><a href="mailto:paul.sori@pm.me">paul.sori@pm.me</a></h4>
              <blockquote>
                <h5><b>I am currently looking for work!</b> Send me an email if you would like to hire me.</h5>
              </blockquote>
            </div>
          </div>
        </div>
      </div>
    </div>`
});

const transcodeView = Vue.component('transcode-view', {
  data() {
    return {

    };
  },
  template: `
    <div class="container">
      Transcode View
    </div>`
});

const federationView = Vue.component('transcode-view', {
  data() {
    return {

    };
  },
  template: `
    <div class="container">
      Coming Soon
    </div>`
});

const vm = new Vue({
  el: '#content',
  components: {
    'folders-view': foldersView,
    'users-view': usersView,
    'db-view': dbView,
    'advanced-view': advancedView,
    'info-view': infoView,
    'transcode-view': transcodeView,
    'federation-view': federationView,
    'rpn-view': rpnView
  },
  data: {
    currentViewMain: 'info-view',
    componentKey: false
  }
});

function changeView(viewName, el){
  if (vm.currentViewMain === viewName) {
    return;
  }

  vm.currentViewMain = viewName;

  const elements = document.querySelectorAll('.side-nav-item'); // or:
  elements.forEach(elm => {
    elm.classList.remove("select")
  });

  el.classList.add("select");

  // close nav on mobile
  closeSideMenu();
}

const fileExplorerModal = Vue.component('file-explorer-modal', {
  data() {
    return {
      componentKey: false, // Flip this value to force re-render,
      pending: false,
      currentDirectory: null,
      contents: []
    };
  },
  template: `
    <div>
      <div class="row">
        <h5>File Explorer</h5>
        <span>
          [<a v-on:click="goToDirectory(currentDirectory, '..')">back</a>]
          [<a v-on:click="goToDirectory('~')">home</a>]
          [<a v-on:click="goToDirectory(currentDirectory)">refresh</a>]
        </span>
      </div>
      <div v-show="currentDirectory === null || pending === true" class="row">
        <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
      </div>
      <div v-show="currentDirectory !== null" class="row">
        <h6>{{currentDirectory}}</h6>
        [<a v-on:click="selectDirectory(currentDirectory)">Select Current Directory</a>]
        <ul class="collection">
          <li v-on:click="goToDirectory(currentDirectory, dir.name)" v-for="dir in contents" class="collection-item">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" height="32.4px"><path fill="#FFA000" d="M38 12H22l-4-4H8c-2.2 0-4 1.8-4 4v24c0 2.2 1.8 4 4 4h31c1.7 0 3-1.3 3-3V16c0-2.2-1.8-4-4-4z"/><path fill="#FFCA28" d="M42.2 18H15.3c-1.9 0-3.6 1.4-3.9 3.3L8 40h31.7c1.9 0 3.6-1.4 3.9-3.3l2.5-14c.5-2.4-1.4-4.7-3.9-4.7z"/></svg>
            <div>{{dir.name}}</div>
            <a v-on:click.stop="selectDirectory(currentDirectory, dir.name)" class="secondary-content waves-effect waves-light btn-small">Select</a>
          </li>
        </ul>
      </div>
    </div>`,
  created: async function () {
    this.goToDirectory('~');
  },
  methods: {
    goToDirectory: async function (dir, joinDir) {
      try {
        const params = { directory: dir };
        if (joinDir) { params.joinDirectory = joinDir; }
  
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/file-explorer`,
          data: params
        });
  
        this.currentDirectory = res.data.path
  
        while (this.contents.length > 0) {
          this.contents.pop();
        }
  
        res.data.directories.forEach(d => {
          this.contents.push(d);
        });

        this.$nextTick(() => {
          document.getElementById('dynamic-modal').scrollIntoView();
        });
      } catch(err) {
        iziToast.error({
          title: 'Failed to get directory contents',
          position: 'topCenter',
          timeout: 3500
        });
      }
    },
    selectDirectory: async function (dir, joinDir) {
      try {
        let selectThis = dir;

        if (joinDir) {
          const res = await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/file-explorer`,
            data: { directory: dir, joinDirectory: joinDir }
          });  
  
          selectThis = res.data.path
        }
  
        Vue.set(ADMINDATA.sharedSelect, 'value', selectThis);
  
        // close the modal
        M.Modal.getInstance(document.getElementById('admin-modal')).close();
        // reset the modal
        modVM.currentViewModal = 'null-modal';
      }catch(err) {
        iziToast.error({
          title: 'Cannot Select Directory',
          position: 'topCenter',
          timeout: 3500
        });
      }
    }
  }
});

const userPasswordView = Vue.component('user-password-view', {
  data() {
    return {
      users: ADMINDATA.users,
      currentUser: ADMINDATA.selectedUser,
      resetPassword: '',
      submitPending: false
    };
  }, 
  template: `
    <form @submit.prevent="updatePassword">
      <div class="modal-content">
        <h4>Password Reset</h4>
        <p>User: <b>{{currentUser.value}}</b></p>
        <div class="input-field">
          <input v-model="resetPassword" id="reset-password" required type="password">
          <label for="reset-password">New Password</label>
        </div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">Go Back</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{submitPending === false ? 'Update Password' : 'Updating...'}}
        </button>
      </div>
    </form>`,
  methods: {
    updatePassword: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/users/password`,
          data: {
            username: this.currentUser.value,
            password: this.resetPassword
          }
        });  
  
        // close & reset the modal
        M.Modal.getInstance(document.getElementById('admin-modal')).close();
        modVM.currentViewModal = 'null-modal';

        iziToast.success({
          title: 'Password Updated',
          position: 'topCenter',
          timeout: 3500
        });
      }catch(err) {
        iziToast.error({
          title: 'Password Reset Failed',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const usersVpathsView = Vue.component('user-vpaths-view', {
  data() {
    return {
      users: ADMINDATA.users,
      directories: ADMINDATA.folders,
      currentUser: ADMINDATA.selectedUser,
      submitPending: false,
      selectInstance: null
    };
  },
  template: `
    <form @submit.prevent="updateFolders">
      <div class="modal-content">
        <h4>Change Folders Reset</h4>
        <p>User: <b>{{currentUser.value}}</b></p>
        <select :disabled="Object.keys(directories).length === 0" id="edit-user-dirs" multiple>
          <option :selected="users[currentUser.value].vpaths.includes(value)" v-for="(key, value) in directories" :value="value">{{ value }}</option>
        </select>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">Go Back</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{submitPending === false ? 'Update' : 'Updating...'}}
        </button>
      </div>
    </form>`,
    mounted: function () {
      this.selectInstance = M.FormSelect.init(document.querySelectorAll("#edit-user-dirs"));
    },
    beforeDestroy: function() {
      this.selectInstance[0].destroy();
    },
    methods: {
      updateFolders: async function() {
        try {
          this.submitPending = true;

          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/users/vpaths`,
            data: {
              username: this.currentUser.value,
              vpaths: this.selectInstance[0].getSelectedValues()
            }
          });

          // update fronted data
          Vue.set(ADMINDATA.users[this.currentUser.value], 'vpaths', this.selectInstance[0].getSelectedValues());
    
          // close & reset the modal
          M.Modal.getInstance(document.getElementById('admin-modal')).close();
          modVM.currentViewModal = 'null-modal';
  
          iziToast.success({
            title: 'User Permissions Updated',
            position: 'topCenter',
            timeout: 3500
          });
        } catch(err) {
          iziToast.error({
            title: 'Failed to Update Folders',
            position: 'topCenter',
            timeout: 3500
          });
        }finally {
          this.submitPending = false;
        }
      }
    }
});

const userAccessView = Vue.component('user-access-view', {
  data() {
    return {
      users: ADMINDATA.users,
      currentUser: ADMINDATA.selectedUser,
      submitPending: false,
      selectInstance: null,
      userClass: ADMINDATA.users[ADMINDATA.selectedUser.value].admin === true ? 'admin' : (ADMINDATA.users[ADMINDATA.selectedUser.value].admin === true ? 'guest' : 'user')
    };
  },
  template: `
    <form @submit.prevent="updateUser">
      <div class="modal-content">
        <h4>Change User Access</h4>
        <p>User: <b>{{currentUser.value}}</b></p>
        <select v-model="userClass" id="user-access-dropdown">
          <option value="admin">Admin</option>
          <option value="user">User</option>
          <option value="guest">Guest</option>
        </select>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">Go Back</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{submitPending === false ? 'Update' : 'Updating...'}}
        </button>
      </div>
    </form>`,
    mounted: function () {
      this.selectInstance = M.FormSelect.init(document.querySelectorAll("#user-access-dropdown"));
    },
    beforeDestroy: function() {
      this.selectInstance[0].destroy();
    },
    methods: {
      updateUser: async function() {
        try {

          // TODO: Warn user if they are removing admin status from the last admin user
            // They will lose all access to the admin panel

          this.submitPending = true;

          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/users/access`,
            data: {
              username: this.currentUser.value,
              admin: this.userClass === 'admin' ? true : false,
              guest: this.userClass === 'guest' ? true : false
            }
          });

          // update fronted data
          Vue.set(ADMINDATA.users[this.currentUser.value], 'admin', this.userClass === 'admin' ? true : false);
          Vue.set(ADMINDATA.users[this.currentUser.value], 'guest', this.userClass === 'guest' ? true : false);
    
          // close & reset the modal
          M.Modal.getInstance(document.getElementById('admin-modal')).close();
          modVM.currentViewModal = 'null-modal';
  
          iziToast.success({
            title: 'User Permissions Updated',
            position: 'topCenter',
            timeout: 3500
          });
        } catch(err) {
          iziToast.error({
            title: 'Failed to Update Folders',
            position: 'topCenter',
            timeout: 3500
          });
        }finally {
          this.submitPending = false;
        }
      }
    }
});

const editPortModal = Vue.component('edit-port-modal', {
  data() {
    return {
      params: ADMINDATA.serverParams,
      submitPending: false,
      currentPort: ADMINDATA.serverParams.port
    };
  },
  template: `
    <form @submit.prevent="updatePort">
      <div class="modal-content">
        <h4>Change Port</h4>
        <div class="input-field">
          <input v-model="currentPort" id="edit-port" required type="number" min="2" max="65535">
          <label for="edit-port">Edit Port</label>
        </div>
        <blockquote>
          Requires a reboot.
        </blockquote>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">Go Back</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{submitPending === false ? 'Update' : 'Updating...'}}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updatePort: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/config/port`,
          data: { port: this.currentPort }
        });

        // update fronted data
        Vue.set(ADMINDATA.serverParams, 'port', this.currentPort);
  
        // close & reset the modal
        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: 'Port Updated.  Server is rebooting',
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: 'Failed to Update Port',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editAddressModal = Vue.component('edit-address-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.serverParams.address
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      <div class="modal-content">
        <h4>Server Address</h4>
        <div class="input-field">
          <input v-model="editValue" id="edit-server-address" required type="text">
          <label for="edit-server-address">Server Address</label>
        </div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">Go Back</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{submitPending === false ? 'Update' : 'Updating...'}}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/config/address`,
          data: { address: this.editValue }
        });

        // update fronted data
        Vue.set(ADMINDATA.serverParams, 'address', this.editValue);
  
        // close & reset the modal
        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: 'Address Updated.  Server is rebooting',
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: 'Update Failed',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editMaxScanModal = Vue.component('edit-max-scans-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.dbParams.maxConcurrentTasks
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      <div class="modal-content">
        <h4>Max Concurrent Scans</h4>
        <div class="input-field">
          <input v-model="editValue" id="edit-max-scans" required type="number" min="1">
          <label for="edit-max-scans">Edit Max Scans</label>
        </div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">Go Back</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{submitPending === false ? 'Update' : 'Updating...'}}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/max-concurrent-scans`,
          data: { maxConcurrentTasks: this.editValue }
        });

        // update fronted data
        Vue.set(ADMINDATA.dbParams, 'maxConcurrentTasks', this.editValue);
  
        // close & reset the modal
        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: 'Updated Successfully',
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: 'Update Failed',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editPauseModal = Vue.component('edit-pause-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.dbParams.pause
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      <div class="modal-content">
        <h4>Scan Pause</h4>
        <div class="input-field">
          <input v-model="editValue" id="edit-db-pause" required type="number" min="1">
          <label for="edit-db-pause">Edit Pause</label>
        </div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">Go Back</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{submitPending === false ? 'Update' : 'Updating...'}}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/pause`,
          data: { pause: this.editValue }
        });

        // update fronted data
        Vue.set(ADMINDATA.dbParams, 'pause', this.editValue);
  
        // close & reset the modal
        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: 'Updated Successfully',
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: 'Update Failed',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editBootScanView = Vue.component('edit-boot-scan-delay-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.dbParams.bootScanDelay
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      <div class="modal-content">
        <h4>Boot Scan Delay</h4>
        <div class="input-field">
          <input v-model="editValue" id="edit-scan-delay" required type="number" min="1">
          <label for="edit-scan-delay">Boot Scan Delay</label>
        </div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">Go Back</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{submitPending === false ? 'Update' : 'Updating...'}}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/boot-scan-delay`,
          data: { bootScanDelay: this.editValue }
        });

        // update fronted data
        Vue.set(ADMINDATA.dbParams, 'bootScanDelay', this.editValue);
  
        // close & reset the modal
        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: 'Updated Successfully',
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: 'Update Failed',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editSaveIntervalView = Vue.component('edit-save-interval-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.dbParams.saveInterval
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      <div class="modal-content">
        <h4>Save Interval</h4>
        <div class="input-field">
          <input v-model="editValue" id="edit-save-interval" required type="number" min="1">
          <label for="edit-save-interval">Save Interval</label>
        </div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">Go Back</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{submitPending === false ? 'Update' : 'Updating...'}}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/save-interval`,
          data: { saveInterval: this.editValue }
        });

        // update fronted data
        Vue.set(ADMINDATA.dbParams, 'saveInterval', this.editValue);
  
        // close & reset the modal
        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: 'Updated Successfully',
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: 'Update Failed',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editScanIntervalView = Vue.component('edit-scan-interval-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.dbParams.scanInterval
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      <div class="modal-content">
        <h4>Edit Scan Interval</h4>
        <div class="input-field">
          <input v-model="editValue" id="edit-scan-interval" required type="number" min="1">
          <label for="edit-scan-interval">Scan Interval</label>
        </div>
      </div>
      <div class="modal-footer">
        <a href="#!" class="modal-close waves-effect waves-green btn-flat">Go Back</a>
        <button class="btn green waves-effect waves-light" type="submit" :disabled="submitPending === true">
          {{submitPending === false ? 'Update' : 'Updating...'}}
        </button>
      </div>
    </form>`,
  mounted: function () {
    M.updateTextFields();
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/scan-interval`,
          data: { scanInterval: this.editValue }
        });

        // update fronted data
        Vue.set(ADMINDATA.dbParams, 'scanInterval', this.editValue);
  
        // close & reset the modal
        M.Modal.getInstance(document.getElementById('admin-modal')).close();

        iziToast.success({
          title: 'Updated Successfully',
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: 'Update Failed',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const nullModal = Vue.component('null-modal', {
  template: '<div>NULL MODAL ERROR: How did you get here?</div>'
});

const modVM = new Vue({
  el: '#dynamic-modal',
  components: {
    'user-password-modal': userPasswordView,
    'user-vpaths-modal': usersVpathsView,
    'user-access-modal': userAccessView,
    'file-explorer-modal': fileExplorerModal,
    'edit-port-modal': editPortModal,
    'edit-address-modal': editAddressModal,
    'edit-scan-interval-modal': editScanIntervalView,
    'edit-save-interval-modal': editSaveIntervalView,
    'edit-boot-scan-delay-modal': editBootScanView,
    'edit-pause-modal': editPauseModal,
    'edit-max-scan-modal': editMaxScanModal,
    'null-modal': nullModal
  },
  data: {
    currentViewModal: 'null-modal'
  }
});
