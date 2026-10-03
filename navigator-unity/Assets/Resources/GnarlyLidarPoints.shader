Shader "Gnarly/LidarPoints"
{
    SubShader
    {
        Tags { "RenderType" = "Transparent" "Queue" = "Transparent+10" "RenderPipeline" = "UniversalPipeline" }

        Pass
        {
            ZWrite Off
            ZTest LEqual
            Cull Off

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 4.5
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            // xyz: session-space position, w: capture time (negative for an empty slot).
            StructuredBuffer<float4> _Points;
            float4x4 _SessionToWorld;
            float4 _BaseColor;
            float4 _PulseColor;
            float3 _PulseOrigin;
            float _PulseRadius;
            float _PulseWidth;
            float _PulseTrail;
            float _PointSize;
            float _MinPixelRadius;
            float _Now;
            float _FreshSeconds;

            static const float2 Corners[6] =
            {
                float2(-1, -1), float2(1, -1), float2(1, 1),
                float2(-1, -1), float2(1, 1), float2(-1, 1)
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float2 corner : TEXCOORD0;
                half3 color : COLOR;
            };

            Varyings vert(uint vertexID : SV_VertexID)
            {
                Varyings o;
                float4 p = _Points[vertexID / 6];
                float2 corner = Corners[vertexID % 6];
                o.corner = corner;
                o.color = 0;
                if (p.w < 0)
                {
                    o.positionCS = float4(0, 0, 0, 1);
                    return o;
                }

                float3 world = mul(_SessionToWorld, float4(p.xyz, 1)).xyz;
                float3 view = TransformWorldToView(world);
                float metersPerPixel = 2 * -view.z / (abs(UNITY_MATRIX_P[1][1]) * _ScreenParams.y);
                view.xy += corner * max(_PointSize, _MinPixelRadius * metersPerPixel);
                o.positionCS = TransformWViewToHClip(view);

                // Bright crest at the pulse front with a decaying afterglow behind it.
                float behind = _PulseRadius - distance(world, _PulseOrigin);
                float crest = behind >= 0
                    ? exp(-behind / _PulseTrail)
                    : exp(-(behind * behind) / (_PulseWidth * _PulseWidth));
                float fresh = saturate(1 - (_Now - p.w) / _FreshSeconds);
                float glow = saturate(max(crest, fresh));
                o.color = lerp(_BaseColor.rgb, _PulseColor.rgb, glow);
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                float r2 = dot(i.corner, i.corner);
                if (r2 > 1) discard;
                return half4(i.color, 1);
            }
            ENDHLSL
        }
    }
}
