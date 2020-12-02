// css variable
document.documentElement.style.setProperty('--vh', `${window.innerHeight/100}px`);
window.addEventListener("resize", () => {
  document.documentElement.style.setProperty('--vh', `${window.innerHeight/100}px`);
});

// document.getElementById("sidenav-button").addEventListener("click", () => {
//   toggleSideMenu();
// }); 

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