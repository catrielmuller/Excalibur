import { Resource } from './Resource';
import { Promise } from '../Promises';
import { Sprite } from '../Drawing/Sprite';
import { Texture } from './Texture';
import { Color } from '../Drawing/Color';
import { SpriteSheet } from '../Drawing/SpriteSheet';
import { Engine } from '../Engine';
/**
 * The [[Texture]] object allows games built in Excalibur to load image resources.
 * [[Texture]] is an [[ILoadable]] which means it can be passed to a [[Loader]]
 * to pre-load before starting a level or game.
 *
 * [[include:Textures.md]]
 */
export class Gif extends Resource<Texture[]> {
  /**
   * The width of the texture in pixels
   */
  public width: number;

  /**
   * The height of the texture in pixels
   */
  public height: number;

  /**
   * A [[Promise]] that resolves when the Texture is loaded.
   */
  public loaded: Promise<any> = new Promise<any>();

  private _isLoaded: boolean = false;
  private _stream: Stream = null;
  private _gif: ParseGif = null;
  private _texture: Texture[] = [];
  private _animation: ex.Animation = null;
  private _transparentColor: ex.Color = null;

  /**
   * Populated once loading is complete
   */
  public images: HTMLImageElement;

  /**
   * @param path       Path to the image resource
   * @param bustCache  Optionally load texture with cache busting
   */
  constructor(public path: string, public color: Color = Color.Magenta, public bustCache = true) {
    super(path, 'arraybuffer', bustCache);
    this._transparentColor = color;
  }

  /**
   * Returns true if the Texture is completely loaded and is ready
   * to be drawn.
   */
  public isLoaded(): boolean {
    return this._isLoaded;
  }

  /**
   * Begins loading the texture and returns a promise to be resolved on completion
   */
  public load(): Promise<Texture[]> {
    var complete = new Promise<Texture[]>();
    var loaded = super.load();
    loaded.then(
      () => {
        this._stream = new Stream(this.getData());
        this._gif = new ParseGif(this._stream, this._transparentColor);
        const promises: Promise<HTMLImageElement>[] = [];
        for (let imageIndex: number = 0; imageIndex < this._gif.images.length; imageIndex++) {
          const texture = new Texture(this._gif.images[imageIndex].src, false);
          this._texture.push(texture);
          promises.push(texture.load());
        }
        Promise.join(promises).then(() => {
          complete.resolve(this._texture);
        });
      },
      () => {
        complete.reject('Error loading texture.');
      }
    );
    return complete;
  }

  public asSprite(id: number = 0): Sprite {
    const sprite = this._texture[id].asSprite();
    return sprite;
  }

  public asSpriteSheet(): SpriteSheet {
    const spriteArray: Sprite[] = this._texture.map((texture) => {
      return texture.asSprite();
    });
    return new SpriteSheet(spriteArray);
  }

  public asAnimation(engine: Engine, speed: number): ex.Animation {
    const spriteSheet: SpriteSheet = this.asSpriteSheet();
    this._animation = spriteSheet.getAnimationForAll(engine, speed);
    return this._animation;
  }
}

export interface Frame {
  sentinel: number;
  type: string;
  leftPos: number;
  topPos: number;
  width: number;
  height: number;
  lctFlag: boolean;
  interlaced: boolean;
  sorted: boolean;
  reserved: boolean[];
  lctSize: number;
  lzwMinCodeSize: number;
  pixels: number[];
}

// Generic functions
var bitsToNum = (ba: any) => {
  return ba.reduce(function(s: number, n: number) {
    return s * 2 + n;
  }, 0);
};

var byteToBitArr = (bite: any) => {
  var a = [];
  for (var i = 7; i >= 0; i--) {
    a.push(!!(bite & (1 << i)));
  }
  return a;
};

// Stream
export class Stream {
  // this.data = new Int8Array(data);
  data: any = null;
  len: number = 0;
  position: number = 0;

  constructor(dataArray: ArrayBuffer) {
    this.data = new Uint8Array(dataArray);
    this.len = this.data.byteLength;
    console.log(this.len);
  }

  public readByte = () => {
    if (this.position >= this.data.byteLength) {
      throw new Error('Attempted to read past end of stream.');
    }
    //return data.charCodeAt(position++) & 0xFF;
    return this.data[this.position++];
  };

  public readBytes = (n: number) => {
    var bytes = [];
    for (var i = 0; i < n; i++) {
      bytes.push(this.readByte());
    }
    return bytes;
  };

  public read = (n: number) => {
    var s = '';
    for (var i = 0; i < n; i++) {
      s += String.fromCharCode(this.readByte());
    }
    return s;
  };

  public readUnsigned = () => {
    // Little-endian.
    var a = this.readBytes(2);
    return (a[1] << 8) + a[0];
  };
}

const lzwDecode = function(minCodeSize: number, data: any) {
  // TODO: Now that the GIF parser is a bit different, maybe this should get an array of bytes instead of a String?
  var pos = 0; // Maybe this streaming thing should be merged with the Stream?

  const readCode = function(size: number) {
    var code = 0;
    for (var i = 0; i < size; i++) {
      if (data.charCodeAt(pos >> 3) & (1 << (pos & 7))) {
        code |= 1 << i;
      }
      pos++;
    }
    return code;
  };

  var output: any[] = [];

  var clearCode = 1 << minCodeSize;
  var eoiCode = clearCode + 1;

  var codeSize = minCodeSize + 1;

  var dict: any[] = [];

  var clear = function() {
    dict = [];
    codeSize = minCodeSize + 1;
    for (var i = 0; i < clearCode; i++) {
      dict[i] = [i];
    }
    dict[clearCode] = [];
    dict[eoiCode] = null;
  };

  var code;
  var last;

  while (true) {
    last = code;
    code = readCode(codeSize);
    if (code === clearCode) {
      clear();
      continue;
    }
    if (code === eoiCode) {
      break;
    }

    if (code < dict.length) {
      if (last !== clearCode) {
        dict.push(dict[last].concat(dict[code][0]));
      }
    } else {
      if (code !== dict.length) {
        throw new Error('Invalid LZW code.');
      }
      dict.push(dict[last].concat(dict[last][0]));
    }
    output.push.apply(output, dict[code]);

    if (dict.length === 1 << codeSize && codeSize < 12) {
      // If we're at the last code and codeSize is 12, the next code will be a clearCode, and it'll be 12 bits long.
      codeSize++;
    }
  }

  // I don't know if this is technically an error, but some GIFs do it.
  //if (Math.ceil(pos / 8) !== data.length) throw new Error('Extraneous LZW bytes.');
  return output;
};

// The actual parsing; returns an object with properties.
export class ParseGif {
  private _st: Stream = null;
  private _handler: any = {};
  private _transparentColor: Color = null;
  public frames: Frame[] = [];
  public images: HTMLImageElement[] = [];
  public globalColorTable: any[] = [];

  constructor(stream: Stream, color: Color = Color.Magenta) {
    this._st = stream;
    this._handler = {};
    this._transparentColor = color;
    this.parseHeader();
    this.parseBlock();
  }

  // LZW (GIF-specific)
  parseColorTable = (entries: any) => {
    // Each entry is 3 bytes, for RGB.
    var ct = [];
    for (var i = 0; i < entries; i++) {
      ct.push(this._st.readBytes(3));
    }
    return ct;
  };

  readSubBlocks = () => {
    var size, data;
    data = '';
    do {
      size = this._st.readByte();
      data += this._st.read(size);
    } while (size !== 0);
    return data;
  };

  parseHeader = () => {
    var hdr: any = {
      sig: null,
      ver: null,
      width: null,
      height: null,
      colorRes: null,
      globalColorTableSize: null,
      gctFlag: null,
      sorted: null,
      globalColorTable: [],
      bgColor: null,
      pixelAspectRatio: null // if not 0, aspectRatio = (pixelAspectRatio + 15) / 64
    };

    hdr.sig = this._st.read(3);
    hdr.ver = this._st.read(3);
    if (hdr.sig !== 'GIF') {
      throw new Error('Not a GIF file.'); // XXX: This should probably be handled more nicely.
    }

    hdr.width = this._st.readUnsigned();
    hdr.height = this._st.readUnsigned();

    var bits = byteToBitArr(this._st.readByte());
    hdr.gctFlag = bits.shift();
    hdr.colorRes = bitsToNum(bits.splice(0, 3));
    hdr.sorted = bits.shift();
    hdr.globalColorTableSize = bitsToNum(bits.splice(0, 3));

    hdr.bgColor = this._st.readByte();
    hdr.pixelAspectRatio = this._st.readByte(); // if not 0, aspectRatio = (pixelAspectRatio + 15) / 64

    if (hdr.gctFlag) {
      hdr.globalColorTable = this.parseColorTable(1 << (hdr.globalColorTableSize + 1));
      this.globalColorTable = hdr.globalColorTable;
    }
    if (this._handler.hdr && this._handler.hdr(hdr)) {
      console.log(this._handler.hdr);
    }
  };

  parseExt = (block: any) => {
    var parseGCExt = (block: any) => {
      var blockSize = this._st.readByte(); // Always 4
      console.log(blockSize + ' < this should be 4');

      var bits = byteToBitArr(this._st.readByte());
      block.reserved = bits.splice(0, 3); // Reserved; should be 000.
      block.disposalMethod = bitsToNum(bits.splice(0, 3));
      block.userInput = bits.shift();
      block.transparencyGiven = bits.shift();

      block.delayTime = this._st.readUnsigned();

      block.transparencyIndex = this._st.readByte();

      block.terminator = this._st.readByte();

      if (this._handler.gce && this._handler.gce(block)) {
        console.log(this._handler.gce);
      }
    };

    var parseComExt = (block: any) => {
      block.comment = this.readSubBlocks();
      if (this._handler.com && this._handler.com(block)) {
        console.log(this._handler.com);
      }
    };

    var parsePTExt = (block: any) => {
      var blockSize = this._st.readByte(); // Always 12
      console.log(blockSize + ' < this should be 12');
      block.ptHeader = this._st.readBytes(12);
      block.ptData = this.readSubBlocks();
      if (this._handler.pte && this._handler.pte(block)) {
        console.log(this._handler.pte);
      }
    };

    const parseAppExt = (block: any) => {
      var parseNetscapeExt = (block: any) => {
        var blockSize = this._st.readByte(); // Always 3
        console.log(blockSize + ' < this should be 3');
        block.unknown = this._st.readByte(); // ??? Always 1? What is this?
        block.iterations = this._st.readUnsigned();
        block.terminator = this._st.readByte();
        if (this._handler.app && this._handler.app.NETSCAPE && this._handler.app.NETSCAPE(block)) {
          console.log(this._handler.app);
        }
      };

      const parseUnknownAppExt = (block: any) => {
        block.appData = this.readSubBlocks();
        // FIXME: This won't work if a handler wants to match on any identifier.
        if (this._handler.app && this._handler.app[block.identifier] && this._handler.app[block.identifier](block)) {
          console.log(this._handler.app[block.identifier]);
        }
      };

      var blockSize = this._st.readByte(); // Always 11
      console.log(blockSize + ' < this should be 11');
      block.identifier = this._st.read(8);
      block.authCode = this._st.read(3);
      switch (block.identifier) {
        case 'NETSCAPE':
          parseNetscapeExt(block);
          break;
        default:
          parseUnknownAppExt(block);
          break;
      }
    };

    var parseUnknownExt = (block: any) => {
      block.data = this.readSubBlocks();
      if (this._handler.unknown && this._handler.unknown(block)) {
        console.log(this._handler.unknown);
      }
    };

    block.label = this._st.readByte();
    switch (block.label) {
      case 0xf9:
        block.extType = 'gce';
        parseGCExt(block);
        break;
      case 0xfe:
        block.extType = 'com';
        parseComExt(block);
        break;
      case 0x01:
        block.extType = 'pte';
        parsePTExt(block);
        break;
      case 0xff:
        block.extType = 'app';
        parseAppExt(block);
        break;
      default:
        block.extType = 'unknown';
        parseUnknownExt(block);
        break;
    }
  };

  parseImg = (img: any) => {
    var deinterlace = (pixels: any, width: any) => {
      // Of course this defeats the purpose of interlacing. And it's *probably*
      // the least efficient way it's ever been implemented. But nevertheless...

      var newPixels = new Array(pixels.length);
      var rows = pixels.length / width;
      var cpRow = (toRow: any, fromRow: any) => {
        var fromPixels = pixels.slice(fromRow * width, (fromRow + 1) * width);
        newPixels.splice.apply(newPixels, [toRow * width, width].concat(fromPixels));
      };

      // See appendix E.
      var offsets = [0, 4, 2, 1];
      var steps = [8, 8, 4, 2];

      var fromRow = 0;
      for (var pass = 0; pass < 4; pass++) {
        for (var toRow = offsets[pass]; toRow < rows; toRow += steps[pass]) {
          cpRow(toRow, fromRow);
          fromRow++;
        }
      }

      return newPixels;
    };

    img.leftPos = this._st.readUnsigned();
    img.topPos = this._st.readUnsigned();
    img.width = this._st.readUnsigned();
    img.height = this._st.readUnsigned();

    var bits = byteToBitArr(this._st.readByte());
    img.lctFlag = bits.shift();
    img.interlaced = bits.shift();
    img.sorted = bits.shift();
    img.reserved = bits.splice(0, 2);
    img.lctSize = bitsToNum(bits.splice(0, 3));

    if (img.lctFlag) {
      img.lct = this.parseColorTable(1 << (img.lctSize + 1));
    }

    img.lzwMinCodeSize = this._st.readByte();

    var lzwData = this.readSubBlocks();

    img.pixels = lzwDecode(img.lzwMinCodeSize, lzwData);

    if (img.interlaced) {
      // Move
      img.pixels = deinterlace(img.pixels, img.width);
    }

    this.frames.push(img);
    this.arrayToImage(img);
    if (this._handler.img && this._handler.img(img)) {
      console.log(this._handler);
    }
  };

  public parseBlock = () => {
    var block = {
      sentinel: this._st.readByte(),
      type: ''
    };
    var blockChar = String.fromCharCode(block.sentinel);
    switch (blockChar) {
      case '!':
        block.type = 'ext';
        this.parseExt(block);
        break;
      case ',':
        block.type = 'img';
        this.parseImg(block);
        break;
      case ';':
        block.type = 'eof';
        if (this._handler.eof && this._handler.eof(block)) {
          console.log(this._handler.eof);
        }
        break;
      default:
        throw new Error('Unknown block: 0x' + block.sentinel.toString(16)); // TODO: Pad this with a 0.
    }

    if (block.type !== 'eof') {
      this.parseBlock();
    }
  };

  arrayToImage = (frame: Frame) => {
    let count = 0;
    var c = document.createElement('canvas');
    c.id = count.toString();
    c.width = frame.width;
    c.height = frame.height;
    count++;
    var context = c.getContext('2d');
    var pixSize = 1;
    var y = 0;
    var x = 0;
    for (var i = 0; i < frame.pixels.length; i++) {
      if (x % frame.width === 0) {
        y++;
        x = 0;
      }

      if (this.globalColorTable[frame.pixels[i]]) {
        const rgb =
          '#' +
          this.globalColorTable[frame.pixels[i]]
            .map((x: any) => {
              const hex = x.toString(16);
              return hex.length === 1 ? '0' + hex : hex;
            })
            .join('');

        //context.fillStyle = rgb;
        if (rgb === this._transparentColor.toHex()) {
          context.fillStyle = `rgba(${this.globalColorTable[frame.pixels[i]][0]}, ${this.globalColorTable[frame.pixels[i]][1]}, ${
            this.globalColorTable[frame.pixels[i]][2]
          }, ${0.0})`;
        } else {
          context.fillStyle = `rgba(${this.globalColorTable[frame.pixels[i]][0]}, ${this.globalColorTable[frame.pixels[i]][1]}, ${
            this.globalColorTable[frame.pixels[i]][2]
          }, ${1})`;
        }

        context.fillRect(x, y, pixSize, pixSize);
        x++;
      }
    }
    const img = new Image();
    img.src = c.toDataURL();
    this.images.push(img);
  };
}
