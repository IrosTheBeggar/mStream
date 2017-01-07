# paper-audio-player

A custom audio player with material paper style and clean design.

![Paper-audio-player example](http://nadikun.com/code/paper-audio-player/demo/paper-audio-player.jpg)

## Live demo

Check the Player live [here](http://nadikun.com/code/paper-audio-player/demo).

## Element usage example

Here is an example of code to add a Paper-Audio-Player element to your page:

```html
<paper-audio-player src="track.mp3" title="STING - Desert Rose" color="#F05C38"></paper-audio-player>
```

**Title** and **color** attributes are optional.

## Install

Install the component using [Bower](http://bower.io/):

    bower install paper-audio-player --save

Or [download as ZIP](https://github.com/gorork/paper-audio-player/archive/master.zip).

## Dependencies

- Polymer 1.0
- Paper-progress
- Iron-Icons

These dependencies are managed via [Bower](http://bower.io/). You can
install that via:

    npm install -g bower

Then, go ahead and download the player's dependencies:

    bower install

## Usage

1. Import Web Components' polyfill:

    ```html
    <script src="bower_components/webcomponentsjs/webcomponents.js"></script>
    ```

2. Import Player element:

    ```html
    <link rel="import" href="bower_components/paper-audio-player/paper-audio-player.html">
    ```

3. Start using it!

    ```html
    <paper-audio-player src="track.mp3"></paper-audio-player>
    <paper-audio-player src="podcast-2.mp3" title="My Podcast #2"></paper-audio-player>
    <paper-audio-player src="song.mp3" title="PANG! - Cry Me A River" color="#F05C38"></paper-audio-player>
    ```

## Customization

Attribute     | Options                                 | Description
---           | ---                                     | ---
`src`         | *string*                                | The URL path to the audio file
`title`       | *string*                                | Customize the track name
`color`       | *string*                                | Customize the accent color that will be used
`auto-play`   | *boolean*                               | Will start playing the audio file automatically

## Development

If you wish to work on your element in isolation, we recommend that you use
[Polyserve](https://github.com/PolymerLabs/polyserve) to keep your element's
bower dependencies in line. You can install it via:

    npm install -g polyserve

And you can run it via:

    polyserve

Once running, you can preview your element at
`http://localhost:8080/components/paper-audio-player/`

To work with Demo page styling with Sass, install grunt and its plugins:

    npm install

After you made any changes, create new CSS file:

    gulp

This will convert Sass into CSS and run [Autoprefixer](https://autoprefixer.github.io/).

## Testing

The tests are compatible with [web-component-tester](https://github.com/Polymer/web-component-tester).
Install it via:

    npm install -g web-component-tester

Then, you can run your tests on _all_ of your local browsers via:

    wct

Or, simply navigate to the `/test` directory if you are using Polyserve: `http://localhost:8080/components/paper-audio-player/test/`

#### WCT Tips

`wct -l chrome` will only run tests in chrome.

`wct -p` will keep the browsers alive after test runs (refresh to re-run).

`wct test/some-file.html` will test only the files you specify.

## Contributing

1. Fork it!
2. Create your feature branch: `git checkout -b new-feature`
3. Commit your changes: `git commit -m 'Add some awesomeness'`
4. Push to the branch: `git push origin new-feature`
5. Submit a pull request!

## License

[MIT License](http://nadi.mit-license.org/) © Nadi Dikun
