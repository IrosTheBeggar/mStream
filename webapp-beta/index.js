const app = Vue.createApp({
  data() { return {
    currentViewMain: 'file-explorer-view'
  }}
})

const fileExplorerView = app.component('file-explorer-view', {
  template: `<div>FILE XPLORER THING</div>`
});

const nowPlayingView = app.component('now-playing-view', {
  template: `<div>PLAYLIST THING</div>`
});

const vm = app.mount('#content');


// const vm = new Vue({
//   el: '#content',
//   components: {
//     'file-explorer-view': fileExplorerView,
//     'now-playing-view': nowPlayingView
//   },
//   data: {
//     currentViewMain: false,
//     componentKey: false
//   }
// });


function changeView(viewName, el){
  console.log('YOOO')
  console.log(vm.currentViewMain)
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