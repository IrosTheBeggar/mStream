{
  "targets": [
    {
      "target_name": "netroute",

      "include_dirs": [
        "src",
        "<!(node -e \"require('nan')\")",
      ],

      "sources": [
        "src/netroute.cc",
      ],

      "conditions": [
        ["OS == 'linux'", {
          "sources": ["src/platform-linux.cc"],
        }, {
          "sources": ["src/platform-unix.cc"],
        }],
      ],
    }
  ]
}
