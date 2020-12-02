
// initialize modal
M.Modal.init(document.querySelectorAll('.modal'), {});

const foldersView = Vue.component('folders-view', {
  data() {
    return {
      componentKey: false, // Flip this value to force re-render,
      dirName: '',
      folder: ''
    };
  },
  template: `
    <div>
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Add Folder</span>
              <form id="choose-directory-form" class="choose-directory-form" @submit.prevent="submitForm">
                <div class="input-field">
                  <input v-on:click="addFolderDialog()" @blur="maybeResetForm()" v-model="folder" id="folder-name" required type="text" class="validate">
                  <label for="folder-name">Select Directory</label>
                  <span class="helper-text">Click to choose directory</span>
                </div>
                <div class="input-field">
                  <input @blur="maybeResetForm()" pattern="[a-zA-Z0-9-]+" v-model="dirName" id="add-directory-name" required type="text" class="validate">
                  <label for="add-directory-name">Server Path</label>
                  <span class="helper-text">No special characters</span>
                </div>
                <button class="btn green waves-effect waves-light select-folder-button" type="submit">
                  Add Folder
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>`,
    methods: {
      maybeResetForm: function() {
        if (this.dirName === '' && this.folder === '') {
          document.getElementById("choose-directory-form").reset();
        }
      },
      addFolderDialog: function (event) {
        M.Modal.getInstance(document.getElementById('admin-modal')).open();
      },
      submitForm: function (event) {
        console.log('lol');
      }
    }
});

const usersView = Vue.component('users-view', {
  data() {
    return {};
  },
  template: `
    <div class="paul-container">
      USERS VIEW
    </div>`
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

  vm.currentViewMain = viewName;

  const elements = document.querySelectorAll('.side-nav-item'); // or:
  elements.forEach(elm => {
    elm.classList.remove("select")
  });

  el.classList.add("select");

  // close nav on mobile
  closeSideMenu();
}

const modVM = new Vue({
  el: '#dynamic-modal',
  components: {
    'file-explorer-modal': fileExplorerModal,
  },
  data: {
    currentViewModal: false
  }
});
