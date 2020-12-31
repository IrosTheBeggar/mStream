const ADMINDATA = (() => {
  const module = {};
  module.sharedSelect = { value: '' };
  module.folders = {};
  module.foldersUpdated = { ts: 0 };
  module.users = { };
  module.usersUpdated = { ts: 0 };

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

  return module;
})();

// Load in data
ADMINDATA.getFolders();
ADMINDATA.getUsers();

// initialize modal
M.Modal.init(document.querySelectorAll('.modal'), {});

const foldersView = Vue.component('folders-view', {
  data() {
    return {
      componentKey: false, // Flip this value to force re-render
      dirName: '',
      folder: ADMINDATA.sharedSelect,
      foldersTS: ADMINDATA.foldersUpdated,
      folders: ADMINDATA.folders
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
                    <button class="btn green waves-effect waves-light col m6 s12" type="submit">
                      Add Folder
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
          const res = await API.axios({
            method: 'PUT',
            url: `${API.url()}/api/v1/admin/directory`,
            data: {
              directory: this.folder.value,
              vpath: this.dirName
            }
          });

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
      userClass: 'user',
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
                      <select :disabled="Object.keys(directories).length === 0" id="new-user-dirs" multiple>
                        <option disabled selected value="" v-if="Object.keys(directories).length === 0">You must add a directory before adding a user</option>
                        <option selected v-for="(key, value) in directories" :value="value">{{ value }}</option>
                      </select>
                      <label for="new-user-dirs">Select User's Directories</label>
                    </div>
                  </div>
                  <div class="row">
                    <div class="input-field col s12 m6">
                      <select v-model="userClass">
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
              </tr>
            </thead>
            <tbody>
              <tr v-for="(v, k) in users">
                <td>{{k}}</td>
                <td>{{v.vpaths.join(', ')}}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>`,
    mounted: function () {
      this.selectInstance = M.FormSelect.init(document.querySelectorAll("select"));
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
      addUser: async function (event) {
        try {
          this.submitPending = true;

          const selected = document.querySelectorAll('#new-user-dirs option:checked');

          const data = {
            username: this.newUsername,
            password: this.newPassword,
            vpaths:Array.from(selected).map(el => el.value),
            admin: this.userClass === 'admin' ? true : false,
            guest: this.userClass === 'guest' ? true : false
          };

          console.log(data)
          await API.axios({
            method: 'PUT',
            url: `${API.url()}/api/v1/admin/user`,
            data: data
          });

          Vue.set(ADMINDATA.users, this.newUsername, { vpaths: data.vpaths, admin: data.admin, guest: data.guest });
          this.newUsername = '';
          this.newPassword = '';
          this.userClass = 'user';

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

const vm = new Vue({
  el: '#content',
  components: {
    'folders-view': foldersView,
    'users-view': usersView,
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
console.log('lol')
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

const nullModal = Vue.component('null-modal', {
  template: '<div>NULL MODAL ERROR: How did you get here?</div>'
});

const modVM = new Vue({
  el: '#dynamic-modal',
  components: {
    'file-explorer-modal': fileExplorerModal,
    'null-modal': nullModal
  },
  data: {
    currentViewModal: 'null-modal'
  }
});
