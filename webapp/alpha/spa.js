document.getElementById("sidenav-cover").addEventListener("click", () => {
  toggleSideMenu();
}); 

function toggleSideMenu() {
  document.getElementById("sidenav-cover").classList.toggle("click-through");

  // Handles initial state rendered on page load
  if (!document.getElementById("sidenav-cover").classList.contains("fade-in") && !document.getElementById("sidenav-cover").classList.contains("fade-out")) {
    document.getElementById("sidenav-cover").classList.toggle("fade-in");
  } else {
    document.getElementById("sidenav-cover").classList.toggle("fade-in");
    document.getElementById("sidenav-cover").classList.toggle("fade-out");
  }

  // Handles initial state rendered on page load
  if (!document.getElementById("sidenav").classList.contains("menu-in") && !document.getElementById("sidenav").classList.contains("menu-out")) {
    document.getElementById("sidenav").classList.toggle("menu-out");
  } else {
    document.getElementById("sidenav").classList.toggle("menu-in");
    document.getElementById("sidenav").classList.toggle("menu-out");
  }

  document.getElementById("sidenav-button").classList.toggle('active');
}

function closeSideMenu() {
  if (document.getElementById("sidenav").classList.contains("menu-out")) {
    toggleSideMenu();
  }
}

document.documentElement.style.setProperty('--vh', `${window.innerHeight/100}px`);
window.addEventListener("resize", () => {
  document.documentElement.style.setProperty('--vh', `${window.innerHeight/100}px`);
});


// The last view changeView opened: what an Instant Mix opened over a view
// that keeps no Back stack of its own goes back to (m.js onBackButton).
let lastView = null;

function changeView(fn, el){
  const elements = document.querySelectorAll('.side-nav-item'); // or:
  elements.forEach(elm => {
    elm.classList.remove("select")
  });

  el.classList.add("select");

  // close nav on mobile
  closeSideMenu();
  // A new view starts its own Back stack: one that keeps none (Auto DJ,
  // Sonic Path, Transcode …) leaves no earlier page's under a mix. Its one
  // entry has no Back branch; the lists that keep a stack replace it.
  lastView = { fn, el };
  programState = [{ state: 'view' }];
  fn();
}

function toggleThing(el, bool) {
  document.querySelectorAll('.m-tab').forEach(elm => {
    elm.classList.remove("selected-tab")
  });

  el.classList.add("selected-tab");

  if (bool === false) {
    document.getElementById('browser').classList.add('hide-on-small-only');
  }else {
    document.getElementById('browser').classList.remove('hide-on-small-only');
  }
}