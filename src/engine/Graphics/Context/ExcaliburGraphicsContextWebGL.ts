import { ExcaliburGraphicsContext, ExcaliburContextDiagnostics } from './ExcaliburGraphicsContext';
import vertexSource from './shaders/vertex.glsl';
import fragmentSource from './shaders/fragment.glsl';

import { Matrix } from '../../Math/matrix';
import { Shader } from './shader';
import { MatrixStack } from './matrix-stack';
import { Batch } from './batch';
import { DrawImageCommand } from './command';
import { TextureManager } from './texture-manager';
import { Graphic } from '../Graphic';
import { Vector } from '../../Algebra';
import { Color } from '../../Drawing/Color';
import { ensurePowerOfTwo } from './webgl-util';
import { StateStack } from './state-stack';
import { Pool } from './pool';
import { Logger } from '../../Util/Log';

export class ExcaliburGraphicsContextWebGL implements ExcaliburGraphicsContext {
  /**
   * Meant for internal use only. Access the internal context at your own risk
   * @internal
   */
  public __gl: WebGLRenderingContext;
  private _textureManager = new TextureManager(this);
  private _stack = new MatrixStack();
  private _state = new StateStack();
  private _ortho!: Matrix;

  private _vertBuffer: WebGLBuffer | null = null;
  /**
   * The _verts are a packed [x, y, u, v, texId]
   */
  private _verts: Float32Array;

  private _maxDrawingsPerBatch: number = 2000;

  // 8 is the minimum defined in the spec
  private _maxGPUTextures: number = 8;
  private _batches: Batch[] = [];

  private _commandPool: Pool<DrawImageCommand>;
  private _batchPool: Pool<Batch>;

  // TODO
  public snapToPixel: boolean = true;

  public backgroundColor: Color = Color.ExcaliburBlue;

  public get opacity(): number {
    return this._state.current.opacity;
  }

  public set opacity(value: number) {
    this._state.current.opacity = value;
  }

  public get z(): number {
    return this._state.current.z;
  }

  public set z(value: number) {
    this._state.current.z = value;
  }

  public get width() {
    return this.__gl.canvas.width;
  }

  public get height() {
    return this.__gl.canvas.height;
  }

  // TODO should this be a canvas element? or a better abstraction
  constructor(_ctx: WebGLRenderingContext) {
    this.__gl = _ctx;
    const vertexSize = 6 * 7; // 6 verts per quad, 7 pieces of float data
    this._verts = new Float32Array(vertexSize * this._maxDrawingsPerBatch);
    this._init();
  }

  private _transformFragmentSource(source: string, maxTextures: number): string {
    let newSource = source.replace('%%count%%', maxTextures.toString());
    let texturePickerBuilder = '';
    for (let i = 0; i < maxTextures; i++) {
      texturePickerBuilder += `   } else if (v_textureIndex <= ${i}.5) {\n
                gl_FragColor = texture2D(u_textures[${i}], v_texcoord);\n
                gl_FragColor.w = gl_FragColor.w * v_opacity;\n`;
    }
    newSource = newSource.replace('%%texture_picker%%', texturePickerBuilder);
    return newSource;
  }

  private _init() {
    const gl = this.__gl;
    // Setup viewport and view matrix
    this._ortho = Matrix.ortho(0, gl.canvas.width, gl.canvas.height, 0, 400, -400);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

    // Clear background
    gl.clearColor(this.backgroundColor.r / 255, this.backgroundColor.g / 255, this.backgroundColor.b / 255, this.backgroundColor.a);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // gl.enable(gl.CULL_FACE);
    // gl.disable(gl.DEPTH_TEST);

    // TODO make alpha blending optional?
    // Enable alpha blending
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Initialize VBO
    // https://groups.google.com/forum/#!topic/webgl-dev-list/vMNXSNRAg8M
    this._vertBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vertBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this._verts, gl.DYNAMIC_DRAW);

    // Initialilze default batch rendering shader
    this._maxGPUTextures = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
    const shader = new Shader(gl, vertexSource, this._transformFragmentSource(fragmentSource, this._maxGPUTextures));
    shader.addAttribute('a_position', 3, gl.FLOAT);
    shader.addAttribute('a_texcoord', 2, gl.FLOAT);
    shader.addAttribute('a_textureIndex', 1, gl.FLOAT);
    shader.addAttribute('a_opacity', 1, gl.FLOAT);
    shader.addUniformMatrix('u_matrix', this._ortho.data);
    // Initialize texture slots to [0, 1, 2, 3, 4, .... maxGPUTextures]
    shader.addUniformIntegerArray(
      'u_textures',
      [...Array(this._maxGPUTextures)].map((_, i) => i)
    );
    // Bind the shader program and connect attributes to VBO
    shader.bind(this._vertBuffer);

    this._commandPool = new Pool<DrawImageCommand>(() => new DrawImageCommand(), this._maxDrawingsPerBatch);
    this._batchPool = new Pool<Batch>(() => new Batch(this._textureManager, this._maxDrawingsPerBatch, this._maxGPUTextures));
  }

  drawImage(graphic: Graphic, x: number, y: number): void;
  drawImage(graphic: Graphic, x: number, y: number, width: number, height: number): void;
  drawImage(
    graphic: Graphic,
    sx: number,
    sy: number,
    swidth?: number,
    sheight?: number,
    dx?: number,
    dy?: number,
    dwidth?: number,
    dheight?: number
  ): void;
  drawImage(
    graphic: Graphic,
    sx: number,
    sy: number,
    swidth?: number,
    sheight?: number,
    dx?: number,
    dy?: number,
    dwidth?: number,
    dheight?: number
  ): void {
    if (!graphic) {
      Logger.getInstance().warn('Cannot draw a null or undefined image');
      // tslint:disable-next-line: no-console
      if (console.trace) {
        // tslint:disable-next-line: no-console
        console.trace();
      }
      return;
    }
    // this._textureManager.updateFromGraphic(graphic);
    const command = this._commandPool.get().init(graphic, sx, sy, swidth, sheight, dx, dy, dwidth, dheight);
    command.applyTransform(this._stack.transform, this._state.current.opacity, this._state.current.z);

    if (this._batches.length === 0) {
      this._batches.push(this._batchPool.get());
    }

    let lastBatch = this._batches[this._batches.length - 1];
    let added = lastBatch.maybeAdd(command);
    if (!added) {
      const newBatch = this._batchPool.get();
      newBatch.add(command);
      this._batches.push(newBatch);
    }
  }

  _updateVertexBufferData(batch: Batch): void {
    let vertIndex = 0;
    // const vertexSize = 6 * 7; // 6 vertices * (x, y, z, u, v, textureId, opacity)
    let x: number = 0;
    let y: number = 0;
    let sx: number = 0;
    let sy: number = 0;
    let sw: number = 0;
    let sh: number = 0;
    let potWidth: number = 0;
    let potHeight: number = 0;
    let textureId = 0;
    for (let command of batch.commands) {
      x = command.dest[0];
      y = command.dest[1];
      sx = command.view[0];
      sy = command.view[1];
      sw = command.view[2];
      sh = command.view[3];

      potWidth = ensurePowerOfTwo(command.image.getSource().width || command.width);
      potHeight = ensurePowerOfTwo(command.image.getSource().height || command.height);

      // TODO should this be handled by the batch
      if (this._textureManager.hasWebGLTexture(command.image)) {
        textureId = batch.textures.indexOf(this._textureManager.getWebGLTexture(command.image));
      }
      if (this.snapToPixel) {
        // quick bitwise truncate
        x = ~~x;
        y = ~~y;
      }
      // potential optimization when divding by 2 (bitshift)
      // TODO we need to validate drawImage before we get here with an error :O

      // Modifying the images to poweroftwo images warp the UV coordinates
      let uvx0 = sx / potWidth;
      let uvy0 = sy / potHeight;
      let uvx1 = (sx + sw) / potWidth;
      let uvy1 = (sy + sh) / potHeight;

      // Quad update
      // (0, 0, z)
      this._verts[vertIndex++] = command.geometry[0][0]; // x + 0 * width;
      this._verts[vertIndex++] = command.geometry[0][1]; //y + 0 * height;
      this._verts[vertIndex++] = command.z;

      // UV coords
      this._verts[vertIndex++] = uvx0; // 0;
      this._verts[vertIndex++] = uvy0; // 0;
      // texture id
      this._verts[vertIndex++] = textureId;
      // opacity
      this._verts[vertIndex++] = command.opacity;

      // (0, 1)
      this._verts[vertIndex++] = command.geometry[1][0]; // x + 0 * width;
      this._verts[vertIndex++] = command.geometry[1][1]; // y + 1 * height;
      this._verts[vertIndex++] = command.z;

      // UV coords
      this._verts[vertIndex++] = uvx0; // 0;
      this._verts[vertIndex++] = uvy1; // 1;
      // texture id
      this._verts[vertIndex++] = textureId;
      // opacity
      this._verts[vertIndex++] = command.opacity;

      // (1, 0)
      this._verts[vertIndex++] = command.geometry[2][0]; // x + 1 * width;
      this._verts[vertIndex++] = command.geometry[2][1]; // y + 0 * height;
      this._verts[vertIndex++] = command.z;

      // UV coords
      this._verts[vertIndex++] = uvx1; //1;
      this._verts[vertIndex++] = uvy0; //0;
      // texture id
      this._verts[vertIndex++] = textureId;
      // opacity
      this._verts[vertIndex++] = command.opacity;

      // (1, 0)
      this._verts[vertIndex++] = command.geometry[3][0]; // x + 1 * width;
      this._verts[vertIndex++] = command.geometry[3][1]; // y + 0 * height;
      this._verts[vertIndex++] = command.z;

      // UV coords
      this._verts[vertIndex++] = uvx1; //1;
      this._verts[vertIndex++] = uvy0; //0;
      // texture id
      this._verts[vertIndex++] = textureId;
      // opacity
      this._verts[vertIndex++] = command.opacity;

      // (0, 1)
      this._verts[vertIndex++] = command.geometry[4][0]; // x + 0 * width;
      this._verts[vertIndex++] = command.geometry[4][1]; // y + 1 * height
      this._verts[vertIndex++] = command.z;

      // UV coords
      this._verts[vertIndex++] = uvx0; // 0;
      this._verts[vertIndex++] = uvy1; // 1;
      // texture id
      this._verts[vertIndex++] = textureId;
      // opacity
      this._verts[vertIndex++] = command.opacity;

      // (1, 1)
      this._verts[vertIndex++] = command.geometry[5][0]; // x + 1 * width;
      this._verts[vertIndex++] = command.geometry[5][1]; // y + 1 * height;
      this._verts[vertIndex++] = command.z;

      // UV coords
      this._verts[vertIndex++] = uvx1; // 1;
      this._verts[vertIndex++] = uvy1; // 1;
      // texture id
      this._verts[vertIndex++] = textureId;
      // opacity
      this._verts[vertIndex++] = command.opacity;
    }
  }

  private _diag: ExcaliburContextDiagnostics = {
    quads: 0,
    batches: 0,
    uniqueTextures: 0,
    maxTexturePerDraw: this._maxGPUTextures
  };

  public get diag(): ExcaliburContextDiagnostics {
    return this._diag;
  }

  public save(): void {
    this._stack.save();
    this._state.save();
  }

  public restore(): void {
    this._stack.restore();
    this._state.restore();
  }

  public translate(x: number, y: number): void {
    this._stack.translate(x, y);
  }

  public rotate(angle: number): void {
    this._stack.rotate(angle);
  }

  public scale(x: number, y: number): void {
    this._stack.scale(x, y);
  }

  public transform(matrix: Matrix) {
    this._stack.transform = matrix;
  }

  clear() {
    const gl = this.__gl;
    gl.clearColor(this.backgroundColor.r / 255, this.backgroundColor.g / 255, this.backgroundColor.b / 255, this.backgroundColor.a);
    // Clear the context with the newly set color. This is
    // the function call that actually does the drawing.
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  flush() {
    const gl = this.__gl;
    this._diag.quads = 0;
    this._diag.uniqueTextures = 0;
    this._diag.batches = 0;
    this._diag.maxTexturePerDraw = this._maxGPUTextures;
    let textures: WebGLTexture[] = [];
    this.clear();

    for (let batch of this._batches) {
      // 6 vertices per quad
      const vertexCount = 6 * batch.commands.length;
      // Build all geometry and ship to GPU
      this._updateVertexBufferData(batch);

      // interleave VBOs https://goharsha.com/lwjgl-tutorial-series/interleaving-buffer-objects/
      gl.bindBuffer(gl.ARRAY_BUFFER, this._vertBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._verts);

      // Bind textures in the correct order
      batch.bindTextures(gl);
      textures = textures.concat(batch.textures);

      // draw the quads
      gl.drawArrays(gl.TRIANGLES, 0, vertexCount);

      this._diag.quads += batch.commands.length;

      for (let c of batch.commands) {
        this._commandPool.free(c);
      }
      this._batchPool.free(batch);
    }

    this._diag.uniqueTextures = textures.filter((v, i, arr) => arr.indexOf(v === i)).length;
    this._diag.batches = this._batches.length;
    this._batches.length = 0;
  }

  /**
   * Draw a debug rectangle to the context
   * @param x
   * @param y
   * @param width
   * @param height
   */
  drawDebugRect(_x: number, _y: number, _width: number, _height: number): void {
    // TODO
  }

  drawLine(_start: Vector, _end: Vector): void {
    // TODO
    // const lines =
  }

  debugFlush() {
    // const gl = this.__gl;
    // gl.drawArrays(gl.LINES, 0, vertexCount);
  }
}
