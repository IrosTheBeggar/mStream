var VUEBROWSER = function() {

    // Auto Focus
    Vue.directive('focus', {
      // When the bound element is inserted into the DOM...
      inserted: function (el) {
        // Focus the element
        el.focus()
      }
    });


    var loginPanel = new Vue({
      el: '#login-overlay',
      data: {
        needToLogin: false,
        error: false,
        errorMessage: 'Login Failed',
        pending: false
      },
      methods: {
        submitCode: function(e){
          // Get Code
          this.pending = true;
          var that = this;
          MSTREAMAPI.login($('#login-username').val(), $('#login-password').val(), function(response, error){
            if(error !== false){
              // Alert the user
              that.pending = false;
              that.error = true;
              return;
            }

            // Eye-candy: change the error message
            that.errorMessage = "Welcome To mStream!";

      			// Add the token to the cookies
      			Cookies.set('token', response.token);

            // Add the token the URL calls
            MSTREAMAPI.updateCurrentServer($('#login-username').val(), response.token, response.vPath)

            // TODO: Add function to load up either the file browser or artist panel

      			// Remove the overlay
      			$('.login-overlay').fadeOut( "slow" ); // TDO: Figure out how to use Vue to fade the modal in and out
            that.pending = false;
            that.needToLogin = false;
          });
        }
      }
    });


    function testIt(token){
  		if(token){
  			 MSTREAMAPI.currentServer.token = token;
  		}

      MSTREAMAPI.ping( function(response, error){
        if(error !== false){
          // NOTE: There needs to be a split here
            // For the webapp we simply display the login panel
            loginPanel.needToLogin = true;
            // TODO: Move this transitionstuff to vue
            $('.login-overlay').fadeIn( "slow" );
            // For electron we need to alert the user that user it failed and guide them to the login form

          return;
        }
        // set vPath
        MSTREAMAPI.currentServer.vPath = response.vPath;

        // TODO: Add function to load up either the file browser or artist panel

      });
  	}

    // NOTE: There needs to be a split here
      // For the normal webap we just get the token
    // var token = Cookies.get('token');
  	testIt(Cookies.get('token'));
      // For electron we need to pull it from wherever electron stores things


};
