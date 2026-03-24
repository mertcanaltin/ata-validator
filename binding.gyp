{
  "targets": [
    {
      "target_name": "ata",
      "sources": [
        "binding/ata_napi.cpp",
        "src/ata.cpp",
        "deps/simdjson/simdjson.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "include",
        "deps/simdjson",
        "<!@(node -e \"var p=process.platform,a=process.arch;if(p==='darwin'){console.log(a==='arm64'?'/opt/homebrew/opt/re2/include':'/usr/local/opt/re2/include');console.log(a==='arm64'?'/opt/homebrew/opt/abseil/include':'/usr/local/opt/abseil/include')}else{console.log('/usr/include')}\")"
      ],
      "libraries": [
        "<!@(node -e \"var p=process.platform,a=process.arch;if(p==='darwin'){var pre=a==='arm64'?'/opt/homebrew/opt/re2':'/usr/local/opt/re2';console.log('-L'+pre+'/lib -lre2')}else{console.log('-lre2')}\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc": ["-std=c++20"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NDEBUG"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
            "MACOSX_DEPLOYMENT_TARGET": "12.0"
          }
        }],
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": ["/std:c++20", "/EHsc"]
            }
          }
        }]
      ]
    }
  ]
}
