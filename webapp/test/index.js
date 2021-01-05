const app = Vue.createApp({
  data() { return {
    currentViewMain: 'file-explorer-view'
  }},
  methods: {
    toggleMenu(event) {
      toggleSideMenu();
    }
  }
})

const fileExplorerView = app.component('file-explorer-view', {
  template: `<div>FILE EXPLORER</div>`
});

const nowPlayingView = app.component('now-playing-view', {
  template: `<div>CURRENTLY PLAYING</div>`
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