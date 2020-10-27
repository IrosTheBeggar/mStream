const app = Vue.createApp({
  data() { return {
    currentViewMain: 'users-view'
  }},
  methods: {
    toggleMenu(event) {
      toggleSideMenu();
    }
  }
})

const fileExplorerView = app.component('users-view', {
  template: `<div>Users View</div>`
});

const nowPlayingView = app.component('folders-view', {
  template: `<div>FOLDERS</div>`
});

const vm = app.mount('#content');

function changeView(viewName, el){
  if (vm.currentViewMain === viewName) {
    closeSideMenu();
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