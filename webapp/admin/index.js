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
      url: `${API.url()}/api/v1/admin/db-params`
    });

    Object.keys(res.data).forEach(key=>{
      module.dbParams[key] = res.data[key];
    });

    module.dbParamsUpdated.ts = Date.now();
  }

  return module;
})();

// Load in data
ADMINDATA.getFolders();
ADMINDATA.getUsers();
ADMINDATA.getDbParams();

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
              </tr>
            </thead>
            <tbody>
              <tr v-for="(v, k) in folders">
                <td>{{k}}</td>
                <td>{{v.root}}</td>
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
                <span class="card-title">DB Settings</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>Scan Interval:</b> {{dbParams.scanInterval}} hours</td>
                      <td>[<a>info</a>][<a>edit</a>]</span></td>
                    </tr>
                    <tr>
                      <td><b>Boot Scan Delay:</b> {{dbParams.bootScanDelay}} seconds</td>
                      <td>[<a>info</a>][<a>edit</a>]</span></td>
                    </tr>
                    <tr>
                      <td><b>Pause Between Files:</b> {{dbParams.pause}} milliseconds</td>
                      <td>[<a>info</a>][<a>edit</a>]</span></td>
                    </tr>
                    <tr>
                      <td><b>Skip Image Metadata:</b> {{dbParams.skipImg}}</td>
                      <td>[<a>info</a>][<a>edit</a>]</span></td>
                    </tr>
                    <tr>
                      <td><b>Max Concurrent Scans:</b> {{dbParams.maxConcurrentTasks}}</td>
                      <td>[<a>info</a>][<a>edit</a>]</span></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`
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


const vm = new Vue({
  el: '#content',
  components: {
    'folders-view': foldersView,
    'users-view': usersView,
    'db-view': dbView,
    'rpn-view': rpnView
  },
  data: {
    currentViewMain: 'folders-view',
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
    'null-modal': nullModal
  },
  data: {
    currentViewModal: 'null-modal'
  }
});
