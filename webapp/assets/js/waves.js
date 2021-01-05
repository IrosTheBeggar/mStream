/* Based On: https://codepen.io/TrevorWelch/pen/NwERXE */
const WAVES = (() => {
  const module = {};

  module.attachRipples = () => {
    const rippleElements = document.getElementsByClassName("my-waves");
    while(rippleElements.length > 0){
      rippleElements[0].addEventListener('click', function(e) {
        let X = e.pageX - this.offsetLeft;
        let Y = e.pageY - this.offsetTop;
        let rippleDiv = document.createElement("div");
        rippleDiv.classList.add('ripple');
        rippleDiv.setAttribute("style","top:"+Y+"px; left:"+X+"px;");
        let customColor = this.getAttribute('ripple-color');
        if (customColor) rippleDiv.style.background = customColor;
        this.appendChild(rippleDiv);
        setTimeout(() => {
          rippleDiv.parentElement.removeChild(rippleDiv);
        }, 1100);
      });

      rippleElements[0].classList.add('waves');
      rippleElements[0].classList.remove('my-waves');
    }
  }

  module.attachRipples();

  return module;
})();
